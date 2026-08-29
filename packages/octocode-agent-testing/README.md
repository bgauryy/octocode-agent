# @octocodeai/agent-testing

Deterministic mocks and host-conformance utilities for Octocode flows. The package replaces ad-hoc test doubles for Pi tool and command registration, lifecycle events, terminal UI calls, scripted user dialogs, agent turns, browser callbacks, cancellation, and session restart/fork continuity. It also provides a runner for comparing production-host evidence, hashes normalized traces, and reports the first semantic divergence.

```ts
import { createPiFlowHarness } from '@octocodeai/agent-testing';

const flow = createPiFlowHarness({
  cwd: workspace,
  scripted: {
    selects: ['Strict migration'],
    agents: [{ tool: 'plan', action: 'review' }],
    browsers: [{ action: 'accept', payload: { revision: 'sha-256' } }],
  },
});

await extension(flow.pi);
await flow.runTool('plan', { queries: [{ reasoning: 'exercise production registration', action: 'set', steps: ['Implement', 'Verify'] }] });
expect(await flow.ui.select('Policy', ['Strict migration'])).toBe('Strict migration');
expect(await flow.openBrowser('http://127.0.0.1/plan')).toMatchObject({ action: 'accept' });

flow.assertSequence([
  'tool.started',
  'tool.finished',
  'ui.dialog',
  'browser.opened',
  'browser.response',
]);
```

The harness intentionally uses structural host types instead of importing the Pi extension. A package under test can pass `flow.pi` and `flow.context` through its own typed boundary with one cast, without introducing a production dependency cycle.

## What to assert

- `flow.events`: ordered, timestamped transcript of every captured surface.
- `flow.eventsOf(kind)` / `flow.last(kind)`: focused state and UI assertions.
- `flow.assertSequence(kinds)`: ordered subsequence checks that tolerate unrelated rendering events.
- `flow.durable`: test-owned storage that survives `restart()` and `fork()`.
- `flow.script(queue, ...responses)`: add user, agent, or browser responses during a scenario.
- `flow.runTool()` / `runCommand()` / `emit()`: exercise actual registered code through Pi lifecycle hooks.
- `flow.expandPrompt()`: expand a registered slash command through its production handler; ordinary prompts remain user messages.
- `flow.postBrowserMessage()`: POST to a production local-server mount's `__octocode/message` route with real loopback HTTP.
- `flow.newSession()` / `restart()` / `fork()` / `tree()`: emit Pi lifecycle boundaries in host order while preserving branch entries.
- `flow.normalizedTranscript()`: remove workspace-specific paths while preserving ordered semantic events for cross-surface assertions.
- `createIsolatedAwarenessStore(factory)`: give a real production Awareness factory a disposable workspace and SQLite path, then close before cleanup.

For interactive widgets, a `customs` script may be either a final outcome or `{ inputs: [...] }`. The latter instantiates the registered component and sends real key/input bytes, so recommended selection, Back, free text, cancellation, and timeout can be tested without bypassing the widget.

Script queues fail when exhausted. Tool/command names fail on duplicate registration. Unknown, blocked, and pre-aborted tool calls fail explicitly, so an incomplete mock cannot silently make a flow pass.

## Cross-host conformance

`CANONICAL_HOST_SCENARIOS` freezes the RFC's 14 shared scenarios: lifecycle, deterministic turns, streaming tools, policy denial, tool failures, cancellation, steering/follow-up, sessions, compaction, UI, transports, persistence recovery, Codex hooks, and plugin lifecycle.

`createCanonicalHostAdapter()` creates synthetic handlers for testing the comparison runner. A green result from two canonical handler tables is a runner self-test, not Pi/native parity evidence.

`createProductionPiHostAdapter()` and `createProductionNativeHostAdapter()` invoke caller-supplied production entrypoints. The production suite covers lifecycle and registry projection first. It marks the other canonical scenarios as unsupported failures until each adapter invokes that scenario through both production compositions. `runCanonicalHostConformance()` always returns one result per canonical scenario; `runHostConformance()` accepts an explicit bounded subset.

Each report identifies whether its baseline and candidate evidence is `synthetic` or `production`. Each scenario is `matched`, `diverged`, or `unsupported`. Unsupported coverage sets the report result to false and includes a reason for each host, so an incomplete adapter can't appear cutover-ready.

The runner normalizes sequence numbers, timestamps, request/session IDs, workspace paths, ANSI styling, errors, maps, and sets. Each scenario result includes separate SHA-256 trace and effect-ledger comparisons plus the first semantic divergence. `EffectLedger` rejects duplicate effect IDs and prevents model, tool, process, network, write, or message effects during shadow execution.
