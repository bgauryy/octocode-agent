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

## Unified implementation contract

This page is the single implementation contract for native terminal experience.
The widget and workflow documents provide deeper reference material, but they must
not define competing terminal behavior. When those documents and this page differ,
update them to point here and follow this contract.

The terminal uses one typed, sanitized semantic model and two projections:

```text
runtime and session facts
  -> renderer-neutral semantic events
  -> deterministic presentation reducer
     -> OpenTUI visual projection
     -> append-only accessible and alternate projection
```

Both projections use the same public identity, state, text, bounds, and redaction.
The visual projection can use layout, color, and restrained motion. The accessible
projection is line-oriented, append-only, non-animated, and free of cursor addressing,
mouse modes, raw input, and alternate-screen control sequences.

### Experience principles

- Lead with the current outcome, required action, or blocker.
- Use stable cards instead of adding a new line for every progress update.
- Preserve the first transition, latest useful progress, required action, failure,
  and terminal result.
- Use plain labels, consistent field order, and progressive disclosure. Keep raw
  arguments, opaque payloads, internal IDs, and private paths out of the UI.
- Make motion optional. Motion never carries unique meaning, blinking is prohibited,
  and reduced-motion mode renders static state.
- Prefer demand-driven rendering. Sample replaceable progress at no more than four
  visual updates per second; required actions and terminal outcomes bypass sampling.
- Keep the composer, pending action, footer, and failure recovery visible before
  decorative chrome.

### Lifecycle identity and state

Every replaceable lifecycle entry has the following semantic identity:

```text
session generation + lifecycle family + stable public operation identity + surface slot
```

The phase is state, not identity. Internal process IDs, database keys, MCP progress
tokens, worker routing identities, and tool-call arguments are not public operation
identities.

Lifecycle state follows one monotonic progression:

```text
pending -> running -> input required -> succeeded | failed | cancelled | blocked
```

The reducer enforces these rules:

- The first accepted transition establishes the card and its order.
- Newer progress replaces intermediate progress and cannot move a counter backward.
- Required actions, failures, and terminal results are immutable.
- Progress received after terminal settlement is ignored and remains available only
  to bounded diagnostics.
- A session replacement increments the generation and clears entries owned by the
  previous generation.
- Cancellation and retry create explicit transitions. A retry never rewrites the
  settled outcome of an earlier attempt.

### Card anatomy

Every lifecycle card follows the same reading order:

1. Marker and textual state.
2. Human-readable family and public identity.
3. Safe action or target.
4. Latest bounded progress or result.
5. Required action and safe default, when applicable.
6. Elapsed time only for running or settled work.

Color, animation, and position can reinforce this order but cannot change it.
Expanded content remains sanitized and bounded; it never reveals the raw source
event.

### Skill activity cards

Skill discovery and mutation use a dedicated `skill.activity` semantic card. The
generic presentation surface and generic tool card are not valid fallbacks for a
known Skill lifecycle.

The card exposes the following fields in order:

| Field | Contract |
|---|---|
| Skill | Bounded public name, or `Catalog` for discovery |
| Source | `Built in`, `User`, `Workspace`, or another validated public scope |
| Action | Discover, enable, disable, refresh, install, update, or remove |
| State | Pending, running, approval required, rejected, completed, failed, or cancelled |
| Result | Bounded count, revision summary, policy explanation, or safe failure summary |

Discovery bursts use one replaceable card per source scope. Activation,
deactivation, refresh, policy rejection, completion, and failure remain distinct
typed states. Every field passes control stripping, credential redaction, bidirectional
text handling, grapheme-aware bounds, and alternate-output parity checks.

### Session receipts

Create, resume, switch, and fork emit one `session.receipt` only after the durable
session transition commits. A receipt has a display name and separate short public
identifier; it never uses a database key as presentation text.

The receipt uses one of these mutually exclusive states:

| State | Meaning |
|---|---|
| Fresh | A new session committed without restored history |
| Resumed empty | A prior session committed with no restored visible messages |
| Resumed | A prior session committed with visible history and no committed compaction |
| Resumed compacted | A prior session committed with a committed compaction projection |
| Recovered partially | Committed state loaded, but the runtime did not restore one or more supported projections |
| Forked | A new lineage node committed from source state |

Fields appear only when the runtime can prove them. They use `unknown` when omission
creates ambiguity:

- Restored visible-message count.
- Retained model-context item count.
- Current context occupancy and limit.
- Committed compaction state.

The receipt is row- and grapheme-bounded. It cannot contain storage paths, raw
session keys, message bodies, model-context bodies, compaction summaries, or private
recovery detail.

### Notifications and footer

Notifications use the lifecycle identity and reducer rules from this page. A
replaceable progress update cannot displace a required action, failure, or terminal
result. Activity preserves bounded sanitized history after the active notification
settles.

The footer is a deterministic summary, not an event log. When several operations
overlap, it selects the first applicable state in this order:

1. Approval or other required action.
2. Failure or blocker.
3. Compaction.
4. Session transition.
5. Resource or Skill discovery.
6. Trust resolution.
7. Provider request.
8. Active worker and tool counts.
9. Plan progress.

Lower-priority detail remains available in Activity. Session replacement and action
completion remove stale footer and notification state immediately.

### MCP and worker lifecycle

MCP and worker activity use the same monotonic lifecycle contract and sanitized dual
projection.

MCP coverage includes discovery, connection, tool start, progress, elicitation,
cancellation, success, failure, reconnect, and catalog change. Progress is monotonic
and stops after settlement. Reconnection never presents a possibly committed call as
automatically replayed.

Worker coverage includes spawn, running progress, addressed message delivery,
follow-up, steering, graceful cancellation, forced termination, failure, completion,
and cleanup. Completion racing cancellation settles once. Public cards do not expose
prompts, capabilities, routing identities, process IDs, or private handback content.

Normalized visual and alternate output must communicate the same public identity,
state, safe action, bounded result, and required action. Pixel equality is not a
requirement.

### Input and accessibility

Every pointer handler dispatches the same semantic command as a documented keyboard
path. Tests compare the resulting intent, focus destination, cancellation behavior,
and error behavior. No widget creates a keyboard trap.

`--accessible` uses the append-only semantic projection. Status updates do not steal
focus, animation is disabled, and reading order follows card anatomy. Snapshot tests
do not substitute for task runs with supported assistive technology.

Sensitive terminal input remains unavailable until one end-to-end contract proves
all of the following surfaces:

- Terminal echo and raw-mode behavior.
- Paste, completion, redraw, scrollback, and cancellation.
- Visual, accessible, transcript, history, log, and diagnostic output.
- Restoration after normal exit, validation failure, signal, and renderer failure.

Raw mode alone is not a masking contract. Until every surface passes, a sensitive
input request fails closed with a safe explanation and next action.

### Fault handling and restoration

The native interactive controller is the single shutdown owner. Shutdown is bounded
and idempotent. Application-owned async work settles or cancels before renderer
destruction, and renderer destruction runs from `finally` even after initialization
or presentation failure.

Managed exit scenarios assert the before-and-after state of terminal modes, echo,
cursor visibility and style, mouse tracking, focus reporting, bracketed paste,
keyboard mode, color-scheme mode, alternate screen, title, child process groups,
listeners, timers, and temporary resources. The matrix includes normal exit,
initialization failure, renderer exception, interrupted stream, resize storm,
shutdown race, `SIGINT`, and `SIGTERM`.

`SIGKILL` is not catchable. The application does not promise in-process cleanup for
it; a separate shell or watchdog scenario proves external terminal recovery.

### Completion scenarios

The Terminal UX workstream is complete only when all of the following scenarios have
executable evidence:

| Area | Required scenario evidence |
|---|---|
| Skill activity | Every discovery and mutation state, source scope, secret-shaped field, oversized field, burst, retry, cancellation, and narrow layout |
| Session receipts | Create, empty resume, ordinary resume, compacted resume, partial recovery, switch, and fork with bounded privacy assertions |
| Notifications | Two interleaved families, reordered progress, duplicate progress, retry, cancellation race, action preservation, session replacement, and terminal settlement |
| MCP | Discovery through catalog replacement, including elicitation, cancellation, reconnect, visual output, and accessible output in a real PTY |
| Workers | Spawn through cleanup, including messages, follow-up, steering, cancellation race, failure, completion, visual output, and accessible output in a real PTY |
| Footer | Every pairwise priority overlap plus the full simultaneous overlap case |
| Input | Every pointer action and keyboard equivalent, mouse interaction, focus destination, validation, cancellation, and error outcome |
| Accessibility | Messages, tools, plans, approvals, workers, errors, resize, and exit as append-only task scenarios plus supported screen-reader runs |
| Sensitive input | Fail-closed behavior until echo, history, paste, redraw, output, diagnostics, cancellation, and restoration all pass |
| Faults | Renderer, process, stream, resize, initialization, and shutdown failures with exactly-once cleanup |
| Restoration | Every managed exit path plus external recovery after uncatchable termination |

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

## Event projection

The native runtime projector converts lifecycle events into typed presentation
events before OpenTUI receives them. The renderer never formats raw runtime event
payloads directly.

| Lifecycle family | Primary surface | Required user-visible state |
|---|---|---|
| Session start, resume, fork, and switch | Footer and notification | Opening, resuming, forking, switching, ready, or failed |
| Provider request and response | Footer and Activity | Waiting for the model with bounded retry progress, then cleared on response |
| Resource and trust discovery | Footer and Activity | Discovery or trust resolution in progress, then a bounded completion result |
| Context usage and compaction | Context rail and footer | Occupancy, percentage remaining, token categories, and compaction phase |
| Base tool and Octocode calls | Transcript and Activity | Human action, sanitized target, state, and bounded result |
| MCP calls and Skills | Transcript and Activity | Server or Skill identity, safe operation summary, state, and bounded result |
| Plans and workers | Dedicated widgets and Activity | Stable public identity, progress, blocking state, and available action |
| Approvals and questions | Action plane | Exact safe action, supported decisions, and default consequence |
| Settings and plugin lifecycle | Notification | Fixed bounded completion or failure text without opaque payloads |

Lifecycle status uses a single priority order when several operations overlap:
compaction, session transition, resource discovery, trust resolution, then provider
request. Detailed history remains available in Activity; the footer doesn't become
an event log.

Assistant completion state remains visible. Failed messages use a `Failed` label,
and interrupted messages use a `Cancelled` label. The projector removes hidden
thinking text before transcript rendering; only the safe observable phase is
eligible for display.

Base-tool summaries use these public names:

| Runtime tool | Public name | Summary focus |
|---|---|---|
| `file` | Files | Read, write, edit, or delete plus a sanitized path |
| `bash` | Terminal | Bounded command summary and exit result |
| `web` | Web | Search, fetch, or batch operation plus a sanitized target |
| `runFfmpeg` | Media | Inspect or process plus a sanitized media target |
| `octocode` | Code research | Catalog, schema, call, or parallel research action |

MCP and Skill adapters follow the same rule: derive bounded semantic fields from
validated input and never fall back to rendering the complete argument object.

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

The detailed Context pane can show input, output, cache-read, and cache-write token
counts. The compact footer uses the current context occupancy—not cumulative session
usage—to calculate the percentage remaining.

Session switching is a state replacement, not an append operation. The renderer
clears the previous transcript and rehydrates the selected session. Resume after
compaction reconstructs visible history from committed session messages while the
model receives only the separately retained model context.

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
