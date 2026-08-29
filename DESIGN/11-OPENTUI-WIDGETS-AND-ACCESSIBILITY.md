# OpenTUI widgets and accessibility

Status: implemented widget and native-input candidate; release evidence remains incomplete  
Audience: terminal maintainers and coding agents

This reference describes the class-based widget system under
`packages/octocode-agent/src/terminal/opentui/widgets/`. It records what each
widget may represent, how agents must choose it, and which accessibility and
recovery rules its `instructions` property exposes.

The widget classes are production-projected by `SemanticWidgetController` and
materialized by `OpenTuiSemanticAdapter`. In the full-screen path, OpenTUI owns
input, queues composer submissions, routes modal control events with generation
checks, and restores composer focus after resolution. Headless, alternate, and
test terminals retain the external line-reader path. Mouse parity, an approved
user-facing alternate-output mode, and release evidence remain open. See
[Known remaining work](#known-remaining-work).

## Shared contract

Every widget extends `OpenTuiWidget` and provides these stable surfaces:

- `id` and `kind` identify an instance and its widget type.
- `capabilities` declares whether the widget is focusable and whether it accepts
  keys, text, multiline text, selection, or no input.
- `accessibility` carries a semantic role, label, optional description, live
  region policy, and keyboard help.
- `instructions` tells agents the widget purpose, when to use or avoid it,
  accepted inputs, state and output rules, keys, accessibility behavior, and
  recovery behavior.
- `render()` returns an immutable `WidgetRenderState`; an optional
  `WidgetRenderAdapter` materializes that state.
- `handleInput()` accepts typed semantic input and returns handled, ignored, or
  invalid with an optional typed intent.
- Lifecycle methods enforce created, mounted, active, disabled, failed, and
  destroyed transitions.

`WidgetRegistry` provides bounded, deterministic registration and construction
with duplicate, capacity, identity, and factory-result checks. `WidgetHost`
owns production instance identity, lifecycle, focus, and destruction. The
projection controller constructs the twelve built-in classes directly;
registry-driven production discovery is not yet composed.

`sanitize.ts` is the shared terminal text boundary. It removes terminal control
sequences and bidirectional formatting controls, normalizes tabs and line
breaks, truncates at grapheme boundaries, validates stable terminal IDs, and
redacts common credential forms. Widget-specific validation adds authority,
identity, size, lifecycle, and state-transition rules.

## Runtime authority boundaries

The semantic classes render state; they do not own domain truth or execute
effects.

- The runtime owns session identity, workspace trust, connection state, usage,
  plan state, verification receipts, tool outcomes, notifications, and approval
  scope.
- `SemanticWidgetController` projects immutable `PresentationState` into widget
  snapshots and retains widget identity across updates.
- Widgets validate and present snapshots, produce typed user intents, and never
  execute tools, approve actions, mutate plans, or dispatch notification
  actions.
- `OpenTuiSemanticAdapter` is the only layer in this subsystem that imports
  OpenTUI renderable types.
- The launcher and interaction broker must own intent dispatch, cancellation,
  timeout, and effect authorization. Agent-authored prose is never runtime
  authority.

## Controller hierarchy and event flow

Keep controller ownership narrow. Do not add renderer, focus, or interaction
state to a widget when the state belongs to a higher layer.

```text
runtime event or user input
  -> Zustand PresentationStore
  -> OpenTuiTerminalController
     -> renderer lifecycle and ordered external input
     -> one generation-scoped pending interaction
  -> SemanticWidgetController
     -> presentation-to-widget projection
     -> semantic interaction and announcement routing
  -> WidgetHost
     -> instance identity, lifecycle, focus, and destruction
  -> OpenTuiSemanticAdapter
     -> OpenTUI renderables and native control events
  -> OpenTuiWidget subclass
     -> validation, immutable render state, instructions, and typed intent
```

The source hierarchy is:

- `terminal-controller.ts` owns terminal startup, teardown, input ordering, and
  interaction settlement. `createOpenTuiTerminal()` remains the public factory.
- `index.ts` owns presentation contracts, the pure reducer, and the Zustand
  store. Renderer-local state must not become a second presentation store.
- `widget-controller.ts` owns semantic projection. It composes `WidgetHost`
  instead of duplicating lifecycle and focus maps.
- `widget-host.ts` owns widget instances. It rejects ambiguous duplicate IDs and
  centralizes mount, activation, focus, removal, and destruction.
- `widgets/sanitize.ts` owns the single grapheme segmenter and shared terminal
  text normalization. `widgets/layout.ts` owns terminal-column measurement and
  grapheme-safe fitting. Widgets must not duplicate either pipeline.
- `opentui-adapter.ts` owns toolkit types. OpenTUI types must not cross into the
  presentation store, runtime, or widget contracts.

To add a widget, define its runtime-authoritative input contract. Implement one
`OpenTuiWidget` subclass with complete agent instructions, add its
projection to `SemanticWidgetController`, materialize it in the adapter, and add
contract, projection, adapter, alternate-output, and accessibility tests. Reuse
`WidgetHost` and `sanitize.ts`; do not create another lifecycle registry, focus
store, text sanitizer, or terminal event queue.

## Widget catalog

Each entry summarizes the class's own `instructions` contract. The source files
remain authoritative for exact wording and validation bounds.

### `TranscriptWidget`

- **Purpose:** Render a bounded chronological conversation log and message
  activity.
- **Use:** Show user, assistant, system, and tool messages, including explicit
  streaming and terminal states.
- **Avoid:** Do not use it for tool execution detail or interactive questions.
- **Input and output:** Accept immutable messages with stable IDs. Render text
  segments, suppress thinking content, produce deterministic role-prefixed
  alternate output, and deduplicate live announcements.
- **Keys:** Arrow keys scroll by line, Page Up and Page Down by viewport, and
  Home and End jump to the bounds.
- **Accessibility:** Expose log semantics, role and status words, polite live
  updates, and complete linear alternate output.
- **Recovery:** Reject ambiguous IDs, strip terminal controls, redact
  credentials, and bound text at grapheme boundaries.

### `ToolProgressWidget`

- **Purpose:** Present one real tool call as a stable progress record.
- **Use:** Show pending, running, success, blocked, cancelled, or error state for
  a runtime-authoritative call ID and tool name.
- **Avoid:** Do not create speculative progress or use it for assistant prose.
- **Input and output:** Accept minimized input and classified outcome summaries;
  never infer counts, percentages, duration, or completion. The first terminal
  state remains authoritative.
- **Keys:** Enter expands or collapses bounded input and outcome detail. The
  global focus order reaches each active tool row.
- **Accessibility:** Pair glyphs with status words, use a static running marker
  in reduced-motion mode, and announce only material transitions.
- **Recovery:** Fall back to an indeterminate state for invalid totals, redact
  unsafe summaries, and ignore contradictory terminal updates.

### `PromptInputWidget`

- **Purpose:** Collect one bounded single-line free-form value.
- **Use:** Ask an explicit question when finite choices do not represent the
  answer and local validation is available.
- **Avoid:** Use select for finite choices and confirm for approval. Do not
  request secrets without sensitive mode.
- **Input and output:** Maintain a bounded buffer and cursor. Submit and cancel
  return typed intents. Because OpenTUI 0.5.8 has no masked native control, the
  full-screen adapter omits sensitive controls and exposes only redacted
  semantic output; another approved input route must collect the value.
- **Keys:** Text and paste insert at the cursor; newlines become spaces. Arrow,
  Home, End, Backspace, and Delete edit; Enter submits; Escape or Ctrl-C cancels.
- **Accessibility:** Use the visible question as the textbox label, keep help
  and validation explicit, and never substitute a placeholder for a label.
- **Recovery:** Preserve the value and cursor after validation failure; return
  cancellation without inventing an answer.

### `EditorWidget`

- **Purpose:** Collect and edit one bounded multiline value.
- **Use:** Author or revise prose, code, plans, or other multiline content with
  complete-buffer validation.
- **Avoid:** Use prompt input for one line, select for finite choices, and
  confirm for approval. Typed destructive phrases are not authorization.
- **Input and output:** Preserve a grapheme-indexed cursor, selection,
  undo/redo history, and scroll position. Submit and cancel return typed intents;
  sensitive buffers remain redacted and do not materialize as native controls.
- **Keys:** Enter inserts a newline; Ctrl+Enter or Meta+Enter submits; Escape or
  Ctrl-C cancels. Navigation, selection, deletion, paste, undo, and redo have
  explicit editor bindings.
- **Accessibility:** Use a visible textbox label and expose validation, cursor,
  selection, focus, and keyboard help without color or cursor position alone.
- **Recovery:** Preserve editing state on validation failure and return the
  cancellation reason so the caller decides whether to retain the draft.

### `ComposerAssistWidget`

- **Purpose:** Present bounded completion candidates for slash commands and
  workspace file references without owning command execution or file access.
- **Use:** Show command candidates after `/` at the start of the composer and
  file candidates for the active `@` token.
- **Avoid:** Do not treat a candidate as submitted text, execute commands, or
  infer files that the workspace catalog did not return.
- **Input and output:** Accept immutable loading, ready, empty, and error
  snapshots with stable candidate IDs. Committing a candidate only edits the
  composer; file paths containing spaces are quoted.
- **Keys:** Arrow keys, J and K, Page Up, Page Down, Home, and End navigate;
  Tab or Enter commits; Escape or Ctrl-C closes the completion view.
- **Accessibility:** Expose listbox and option semantics, textual selection and
  candidate-kind labels, bounded announcements, and complete alternate output.
- **Recovery:** Ignore stale asynchronous file results, preserve deterministic
  ordering, exclude generated, secret, and symlinked paths, and leave the
  composer unchanged on cancellation.

### `SelectWidget`

- **Purpose:** Present one bounded listbox and return the chosen stable option
  ID.
- **Use:** Choose from a known finite set, especially when free-form input is
  ambiguous.
- **Avoid:** Use confirm for binary approval and prompt input for free-form text.
  Reject duplicate, visually ambiguous, or silently truncated labels.
- **Input and output:** Keep highlight, committed selection, search, and scroll
  state separate. Consequential selects start unanswered and emit only an
  explicit stable option ID.
- **Keys:** Arrow, Home, End, Page Up, and Page Down navigate; Enter chooses;
  Escape or Ctrl-C cancels. Optional type search and Backspace edit the query.
- **Accessibility:** Provide an explicit listbox label and textual focused,
  selected, recommended, disabled, and disabled-reason markers.
- **Recovery:** Preserve prior state when no enabled option matches or can be
  chosen, then allow navigation or cancellation.

### `ConfirmWidget`

- **Purpose:** Obtain one explicit Yes or No decision for an exact visible
  question and consequence.
- **Use:** Guard a known consequential or destructive action with a scoped binary
  decision.
- **Avoid:** Do not hide missing parameters, bundle actions, solicit secrets, or
  replace select and input flows.
- **Input and output:** Accept only runtime-owned scope. Only the visible choice
  is evidence; No, cancel, and timeout authorize nothing.
- **Keys:** Left, Right, or Tab moves focus; Y and N choose directly; Enter
  submits the focused option; Escape or Ctrl-C cancels. Initial focus is No.
- **Accessibility:** Expose an assertive alert-dialog description, visible focus
  marker, complete consequence, labeled choices, and linear alternate output.
- **Recovery:** Discard approval when action, target, scope, or consequence
  changes. Never reuse approval from another widget or earlier result.

### `HeaderWidget`

- **Purpose:** Render canonical runtime identity and state as a stable header.
- **Use:** Summarize runtime-owned title, session, model, workspace trust, and
  working state.
- **Avoid:** Do not source identity or trust from assistant prose, tool output,
  notifications, or prompts.
- **Input and output:** Accept only runtime-authoritative snapshots. On narrow
  terminals, preserve trust and working state before model and session detail.
- **Keys:** Read only and not focusable.
- **Accessibility:** Use banner semantics and explicit trust and working words;
  provide complete alternate output and grapheme-safe visual truncation.
- **Recovery:** Reject missing authority or invalid canonical fields, strip
  controls, and progressively omit low-priority details when width is limited.

### `FooterWidget`

- **Purpose:** Render active mode, connection, truthful context usage, and the
  canonical active keymap.
- **Use:** Provide persistent runtime-owned mode and connection state plus active
  shortcuts or usage when those values are known.
- **Avoid:** Do not render transient events or infer usage, cost, connection
  health, or shortcuts.
- **Input and output:** Preserve mode and connection first, then material context
  warnings and key hints in priority order. Alternate output stays complete.
- **Keys:** Read only. It displays bindings owned by the active view and creates
  no footer-only shortcuts.
- **Accessibility:** Use explicit connection and context words, linear reading
  order, grapheme-aware fitting, and polite deduplicated announcements.
- **Recovery:** Report context as unavailable when counts are absent, omit
  lower-priority content on narrow terminals, and reject invalid snapshots.

### `StatusNotificationsWidget`

- **Purpose:** Maintain bounded stable lifecycle notifications without
  model-authored urgency.
- **Use:** Show real session, agent, tool, permission, or system lifecycle items
  with stable slot and item IDs.
- **Avoid:** Do not duplicate transcript or tool detail, and do not create
  decorative or speculative alerts.
- **Input and output:** Derive severity and urgency from runtime lifecycle.
  Actions return to the runtime for validation and dispatch; rendering never
  executes them.
- **Keys:** Arrow keys navigate, Home and End jump, Enter returns the selected
  action, and Escape or Ctrl-C returns cancellation.
- **Accessibility:** Use polite status output for info and success, assertive
  alert output for warning and error, and pair each glyph with a severity word.
- **Recovery:** Ignore duplicate updates, bound announcements and history, strip
  control sequences, and evict the oldest item deterministically at capacity.

### `PlanWidget`

- **Purpose:** Render one authoritative execution plan as a bounded read-only
  ordered list.
- **Use:** Inspect runtime-owned plan identity, scope, revision, phase, steps,
  dependencies, checks, and verification receipts.
- **Avoid:** Do not use rendering to propose, approve, edit, reorder, start,
  complete, or clear a plan.
- **Input and output:** Preserve step order and stable IDs. Show the sole doing
  step explicitly; never infer approval, completion, or verification. Alternate
  output includes the complete snapshot.
- **Keys:** Arrow keys scroll by step, Page Up and Page Down by viewport, and
  Home and End jump. No key mutates the plan.
- **Accessibility:** Express phase, status, current step, dependencies, blockers,
  and verification with words and symbols, and announce only material changes.
- **Recovery:** Reject stale revisions, identity or scope drift, reordered IDs,
  unknown dependencies, multiple doing steps, and non-runtime receipts.

### `PresentationSurfaceWidget`

- **Purpose:** Render a runtime-authoritative generic text, list, key-value, or
  truthful progress surface without bypassing the widget contract.
- **Use:** Materialize `ui.present` values that do not belong to transcript,
  tools, plans, prompts, or approvals.
- **Avoid:** Do not use it to infer trusted chrome, tool state, plan state, or
  authorization from legacy display strings.
- **Input and output:** Accept one stable ID, monotonic revision, and one bounded
  payload. Preserve complete linear alternate output and truthful progress.
- **Keys:** Arrow keys, Page Up, Page Down, Home, and End scroll long content.
  The widget is read-only.
- **Accessibility:** Use explicit type, progress, and focus words with a visible
  focus marker and complete color-independent output.
- **Recovery:** Reject missing runtime authority, stale or conflicting
  revisions, identity drift, unsafe controls, oversized collections, and
  ambiguous progress totals.

## Accessibility contract

The roles in `WidgetAccessibilityMetadata` are terminal semantics, not browser
ARIA. OpenTUI does not provide a DOM or an ARIA bridge in this implementation.
The adapter writes labels, roles, descriptions, and region-role prefixes into
terminal output, and each widget supplies a linear alternate representation.
Do not claim that a terminal screen reader receives native ARIA events.

The system-wide rules are:

- A keyboard-only path must exist for every interaction; mouse support may
  mirror it but must never be required.
- Focus must be deterministic and visible in text. Consequential controls must
  not turn initial focus into an inferred answer.
- Status, severity, trust, selection, verification, and progress must use words
  or color-independent glyphs, never color alone.
- Text must be sanitized and bounded at Unicode grapheme boundaries. The footer
  includes width-aware fitting, while complete alternate output preserves
  omitted detail.
- Reduced motion replaces animated progress with a static state. Widgets must
  not depend on blinking or animation for meaning.
- Resize must preserve semantic state. Narrow layouts may omit lower-priority
  visual detail, but must retain essential state and complete alternate output.
- Live announcements must be bounded, deduplicated, and limited to material
  transitions.

Alternate output is a semantic, linear snapshot contract. It is suitable for
redirected output, non-interactive terminals, test assertions, and a future
approved assistive-output route. The controller can compose all widget-specific
alternate representations, but the launcher does not yet expose that route as
an end-user mode.

## Source and test map

| Area | Source | Tests |
| --- | --- | --- |
| Shared contract, lifecycle, registry | `packages/octocode-agent/src/terminal/opentui/widgets/contracts.ts`, `base.ts`, `registry.ts` | `packages/octocode-agent/tests/opentui-widget-contracts.test.ts` |
| Text, identity, and terminal-column safety | `packages/octocode-agent/src/terminal/opentui/widgets/sanitize.ts`, `layout.ts` | `packages/octocode-agent/tests/opentui-widget-sanitize.test.ts`, `opentui-widget-layout.test.ts` |
| Widget instance lifecycle and focus | `packages/octocode-agent/src/terminal/opentui/widget-host.ts` | `packages/octocode-agent/tests/opentui-widget-host.test.ts` |
| Twelve widget classes | `packages/octocode-agent/src/terminal/opentui/widgets/` | `packages/octocode-agent/tests/opentui-*-widget.test.ts` |
| Slash commands and file completion | `packages/octocode-agent/src/native-slash-commands.ts`, `native-composer.ts` | `packages/octocode-agent/tests/native-slash-commands.test.ts`, `native-composer.test.ts` |
| Presentation projection | `packages/octocode-agent/src/terminal/opentui/widget-controller.ts` | `packages/octocode-agent/tests/opentui-widget-controller.test.ts` |
| OpenTUI materialization and layout | `packages/octocode-agent/src/terminal/opentui/opentui-adapter.ts`, `renderer.ts` | `packages/octocode-agent/tests/opentui-renderer.test.ts` |
| Store and interaction bridge | `packages/octocode-agent/src/terminal/opentui/index.ts`, `terminal-controller.ts`, `packages/octocode-agent/src/native-launcher.ts` | `packages/octocode-agent/tests/opentui-terminal.test.ts`, `native-launcher.test.ts` |

## Verification state

The following commands passed after the native-input ownership edits:

```text
yarn workspace octocode-agent test
yarn workspace octocode-agent typecheck
yarn workspace octocode-agent lint
yarn workspace octocode-agent build
NODE_OPTIONS=--experimental-ffi yarn workspace octocode-agent test
node packages/octocode-agent/out/octocode-agent.mjs --help
```

The normal package suite reported 318 passing tests and 15 explicitly skipped
FFI tests. The FFI-enabled suite reported 333 passing tests with no skips. The
package typecheck, lint, build, and built CLI help path passed. Root lint also
passed. The full root test completed successfully across core, testing,
Awareness, shared, native-agent, and Pi-extension workspaces. This remains a
candidate receipt because the external PTY, packaging, accessibility, and
supported-platform release evidence listed below is still incomplete.

## Known remaining work

- Add confirm and notification mouse parity and complete active-view keymap
  ownership. Native input already routes normal and multiline paste, normal
  submit and follow-up dispatch, uses state-sensitive Ctrl-C escalation, and
  rejects stale modal callbacks by interaction generation.
- Expose and approve the alternate-output route for users who cannot consume the
  visual terminal. Internal semantic roles alone are not a screen-reader
  integration.
- Expose the reduced-motion preference through canonical settings; the renderer
  now accepts an injected preference and defaults to static reduced motion.
  Complete terminal-capability and minimum-size coverage. Unicode cursor
  synchronization and grapheme-aware widgets now have FFI coverage.
- Extend the existing `@opentui/core/testing` suite with mouse, clock,
  capability, and golden-frame cases. The current FFI suite covers native
  input, paste synchronization, Unicode cursor movement, semantic text styling,
  modal resolution, searchable selection, focus restoration, generation
  safety, sensitive-value non-leakage, combining-mark completion, input cursor
  conversion, narrow completion visibility, and idle resize behavior.
- Introduce Markdown or code renderables only after presentation state preserves
  trusted content provenance and language metadata. The adapter uses
  `StyledText` for semantic hierarchy today; it does not interpret arbitrary
  transcript or tool text as markup.
- Run real PTY restoration, sustained-stream, native-asset, packaging,
  accessibility, performance, and supported-platform tests with the built CLI.
- Decide whether production widget discovery should use `WidgetRegistry`; today
  the controller constructs the built-in classes directly.

These gaps keep the OpenTUI and Pi-removal release gates on **HOLD**. The target
interaction and release criteria remain in
[`04-TUI-AND-SETTINGS.md`](04-TUI-AND-SETTINGS.md), and work-package ownership
remains in [`10-REMAINING-WORK-PLAN.md`](10-REMAINING-WORK-PLAN.md).
