# @octocodeai/agent-testing

Deterministic mocks for complete Octocode/Pi flows. The package replaces ad-hoc test doubles for Pi tool and command registration, lifecycle events, terminal UI calls, scripted user dialogs, agent turns, browser callbacks, cancellation, and session restart/fork continuity.

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
