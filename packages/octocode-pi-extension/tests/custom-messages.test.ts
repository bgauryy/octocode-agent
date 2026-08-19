/**
 * Custom message renderer tests — branded cards for compaction checkpoints and
 * awareness handoffs.
 *
 * Pins: (1) card builders' collapsed vs expanded output, (2) emitters send a
 * one-line `content` (it enters the LLM context) with rich data only in
 * `details`, display true, and NO trigger-turn options argument, (3) renderer
 * registration covers both custom types and yields width-safe components,
 * (4) the compaction-hooks wiring emits at most one checkpoint card per
 * compaction event.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import {
  AWARENESS_HANDOFF_TYPE,
  COMPACTION_CHECKPOINT_TYPE,
  buildCompactionCard,
  buildHandoffCard,
  emitAwarenessHandoff,
  emitCompactionCheckpoint,
  registerOctocodeMessageRenderers,
  type AwarenessHandoffDetails,
  type CompactionCheckpointDetails,
} from '../src/tools/custom-messages.js';
import {
  registerCompactionHooks,
  resetCompactionCheckpointDedupeForTests,
} from '../src/tools/compaction-hooks.js';
import { resetCompactionArbiterForTests } from '../src/tools/compaction-state.js';
import { resetCompactionResumeStateForTests } from '../src/tools/compaction-resume.js';
import { visibleWidth } from '../src/tools/render-helpers.js';
import type { PiInstance, PiTheme } from '../src/types.js';

const theme = { fg: (c: string, t: string) => '<' + c + '>' + t + '</' + c + '>' } as unknown as PiTheme;

const WIDTH = 200;

type SentMessage = { customType: string; content: string; display?: boolean; details?: unknown };
type Renderer = (message: unknown, options: { expanded?: boolean }, theme: PiTheme) => unknown;
type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

function makePi() {
  const sent: { msg: SentMessage; extraArgs: unknown[] }[] = [];
  const renderers = new Map<string, Renderer>();
  const handlers = new Map<string, Handler[]>();
  const pi = {
    sendMessage: (msg: SentMessage, ...extraArgs: unknown[]) => {
      sent.push({ msg, extraArgs });
    },
    registerMessageRenderer: (type: string, renderer: Renderer) => renderers.set(type, renderer),
    sendUserMessage: () => undefined,
    on: (event: string, handler: Handler) => {
      const arr = handlers.get(event) ?? [];
      arr.push(handler);
      handlers.set(event, arr);
    },
  } as unknown as PiInstance;
  const fire = (event: string, evt: unknown, ctx: unknown) =>
    Promise.all((handlers.get(event) ?? []).map((h) => h(evt, ctx)));
  return { pi, sent, renderers, fire };
}

const compactionDetails: CompactionCheckpointDetails = {
  label: 'entry-42',
  reason: 'threshold',
  tokensBefore: 45000,
  fromExtension: true,
  readFiles: ['src/a.ts', 'src/b.ts'],
  modifiedFiles: ['src/c.ts'],
  summary: 'line one\nline two',
};

const handoffDetails: AwarenessHandoffDetails = {
  label: 'session-7',
  from: 'main',
  to: 'successor',
  goal: 'finish the renderer feature',
  status: 'in-progress',
  notes: ['tests pass', 'wiring pending'],
  artifacts: ['docs/plan.md'],
};

beforeEach(() => {
  resetCompactionCheckpointDedupeForTests();
  resetCompactionArbiterForTests();
  resetCompactionResumeStateForTests();
});

// ─── Card builders ────────────────────────────────────────────────────────────

test('buildCompactionCard collapsed: 1-2 branded lines with label and stats', () => {
  const lines = buildCompactionCard(compactionDetails, false, theme, WIDTH);
  assert.ok(lines.length >= 1 && lines.length <= 2, `collapsed card must be 1-2 lines, got ${lines.length}`);
  assert.match(lines[0]!, /◆/);
  assert.match(lines[0]!, /Compaction checkpoint/);
  assert.match(lines[0]!, /entry-42/);
  assert.match(lines[0]!, /<accent>/, 'brand accents via theme.fg');
  assert.match(lines[1]!, /reason: threshold/);
  assert.match(lines[1]!, /tokens before: 45000/);
  // Collapsed must not show the expanded box frame or file lists.
  assert.ok(!lines.some((l) => l.includes('╭─') || l.includes('╰─')));
  assert.ok(!lines.some((l) => l.includes('src/a.ts')));
});

test('buildCompactionCard expanded: full box with files, source, and summary excerpt', () => {
  const lines = buildCompactionCard(compactionDetails, true, theme, WIDTH);
  assert.match(lines[0]!, /╭─/);
  assert.match(lines[0]!, /Compaction checkpoint/);
  assert.match(lines[lines.length - 1]!, /╰─/);
  const body = lines.join('\n');
  assert.match(body, /source: octocode/);
  assert.match(body, /read files \(2\).*src\/a\.ts, src\/b\.ts/);
  assert.match(body, /modified files \(1\).*src\/c\.ts/);
  assert.match(body, /line one/);
  assert.match(body, /line two/);
});

test('buildCompactionCard omits empty sections and falls back to a label', () => {
  const lines = buildCompactionCard({ label: '' }, true, theme, WIDTH);
  const body = lines.join('\n');
  assert.match(body, /checkpoint/i, 'empty label falls back');
  assert.doesNotMatch(body, /read files/);
  assert.doesNotMatch(body, /modified files/);
  assert.doesNotMatch(body, /reason:/);
});

test('buildHandoffCard collapsed: 1-2 lines with label and route', () => {
  const lines = buildHandoffCard(handoffDetails, false, theme, WIDTH);
  assert.ok(lines.length >= 1 && lines.length <= 2);
  assert.match(lines[0]!, /◆/);
  assert.match(lines[0]!, /Awareness handoff/);
  assert.match(lines[0]!, /session-7/);
  assert.match(lines[1]!, /main → successor/);
  assert.match(lines[1]!, /status: in-progress/);
  assert.ok(!lines.some((l) => l.includes('finish the renderer feature')), 'goal is expanded-only');
});

test('buildHandoffCard expanded: full box with goal, notes, and artifacts', () => {
  const lines = buildHandoffCard(handoffDetails, true, theme, WIDTH);
  assert.match(lines[0]!, /╭─/);
  assert.match(lines[lines.length - 1]!, /╰─/);
  const body = lines.join('\n');
  assert.match(body, /goal:.*finish the renderer feature/);
  assert.match(body, /- tests pass/);
  assert.match(body, /- wiring pending/);
  assert.match(body, /artifacts \(1\).*docs\/plan\.md/);
});

test('card builders truncate every line to the given width', () => {
  const narrow = 24;
  for (const lines of [
    buildCompactionCard(compactionDetails, true, undefined, narrow),
    buildHandoffCard(handoffDetails, true, undefined, narrow),
  ]) {
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= narrow, `line exceeds width ${narrow}: ${JSON.stringify(line)}`);
    }
  }
});

// ─── Emitters ─────────────────────────────────────────────────────────────────

test('emitCompactionCheckpoint: one-line content, details payload, display true, no triggerTurn', () => {
  const { pi, sent } = makePi();
  emitCompactionCheckpoint(pi, compactionDetails);
  assert.equal(sent.length, 1);
  const { msg, extraArgs } = sent[0]!;
  assert.equal(msg.customType, COMPACTION_CHECKPOINT_TYPE);
  assert.equal(msg.display, true);
  assert.equal(msg.details, compactionDetails);
  assert.match(msg.content, /Compaction checkpoint saved: entry-42/);
  assert.ok(!msg.content.includes('\n'), 'content enters the LLM context — must stay one line');
  assert.ok(!msg.content.includes('src/a.ts'), 'rich data lives only in details');
  assert.equal(extraArgs.length, 0, 'no options argument → no triggerTurn');
});

test('emitAwarenessHandoff: one-line content, details payload, display true, no triggerTurn', () => {
  const { pi, sent } = makePi();
  emitAwarenessHandoff(pi, handoffDetails);
  assert.equal(sent.length, 1);
  const { msg, extraArgs } = sent[0]!;
  assert.equal(msg.customType, AWARENESS_HANDOFF_TYPE);
  assert.equal(msg.display, true);
  assert.equal(msg.details, handoffDetails);
  assert.match(msg.content, /Awareness handoff recorded: session-7/);
  assert.ok(!msg.content.includes('\n'));
  assert.ok(!msg.content.includes('finish the renderer feature'));
  assert.equal(extraArgs.length, 0);
});

test('emitters are safe when the host lacks sendMessage', () => {
  const bare = {} as unknown as PiInstance;
  assert.doesNotThrow(() => emitCompactionCheckpoint(bare, compactionDetails));
  assert.doesNotThrow(() => emitAwarenessHandoff(bare, handoffDetails));
});

// ─── Renderer registration ────────────────────────────────────────────────────

test('registerOctocodeMessageRenderers registers both custom types', () => {
  const { pi, renderers } = makePi();
  registerOctocodeMessageRenderers(pi);
  assert.deepEqual(
    [...renderers.keys()].sort(),
    [AWARENESS_HANDOFF_TYPE, COMPACTION_CHECKPOINT_TYPE].sort(),
  );
});

test('registered renderer components render the card lines from message.details', () => {
  const { pi, renderers } = makePi();
  registerOctocodeMessageRenderers(pi);

  const checkpoint = renderers.get(COMPACTION_CHECKPOINT_TYPE)!(
    { role: 'custom', customType: COMPACTION_CHECKPOINT_TYPE, content: 'x', details: compactionDetails },
    { expanded: false },
    theme,
  ) as { render(width: number): string[] };
  const collapsed = checkpoint.render(WIDTH);
  assert.match(collapsed[0]!, /Compaction checkpoint/);
  assert.match(collapsed[0]!, /entry-42/);

  const handoff = renderers.get(AWARENESS_HANDOFF_TYPE)!(
    { role: 'custom', customType: AWARENESS_HANDOFF_TYPE, content: 'x', details: handoffDetails },
    { expanded: true },
    theme,
  ) as { render(width: number): string[] };
  const expanded = handoff.render(WIDTH);
  assert.match(expanded.join('\n'), /finish the renderer feature/);
});

test('registered renderer tolerates a message with no details', () => {
  const { pi, renderers } = makePi();
  registerOctocodeMessageRenderers(pi);
  const component = renderers.get(COMPACTION_CHECKPOINT_TYPE)!(
    { role: 'custom', customType: COMPACTION_CHECKPOINT_TYPE, content: 'x' },
    { expanded: true },
    theme,
  ) as { render(width: number): string[] };
  const lines = component.render(WIDTH);
  assert.ok(lines.length > 0);
  assert.match(lines.join('\n'), /checkpoint/i);
});

test('registerOctocodeMessageRenderers is a no-op on hosts without registerMessageRenderer', () => {
  const bare = {} as unknown as PiInstance;
  assert.doesNotThrow(() => registerOctocodeMessageRenderers(bare));
});

// ─── compaction-hooks wiring + dedupe ─────────────────────────────────────────

function checkpointCards(sent: { msg: SentMessage }[]): SentMessage[] {
  return sent.map((s) => s.msg).filter((m) => m.customType === COMPACTION_CHECKPOINT_TYPE);
}

test('session_compact completion emits exactly one checkpoint card per compaction event', async () => {
  const { pi, sent, fire } = makePi();
  registerCompactionHooks(pi, (() => undefined) as never);
  const event = { compactionEntry: { id: 'c-1', tokensBefore: 90000, summary: 'sum' }, fromExtension: false, reason: 'threshold', willRetry: false };
  await fire('session_compact', event, { hasUI: false });
  await fire('session_compact', event, { hasUI: false });
  const cards = checkpointCards(sent);
  assert.equal(cards.length, 1, 'two hook firings for the same compaction must emit one card');
  assert.equal(cards[0]!.content, 'Compaction checkpoint saved: c-1');
  assert.ok(!cards[0]!.content.includes('\n'));
  const details = cards[0]!.details as CompactionCheckpointDetails;
  assert.equal(details.reason, 'threshold');
  assert.equal(details.tokensBefore, 90000);
  assert.equal(details.summary, 'sum');
  assert.equal(details.fromExtension, false);
});

test('a distinct compaction event emits its own card', async () => {
  const { pi, sent, fire } = makePi();
  registerCompactionHooks(pi, (() => undefined) as never);
  await fire('session_compact', { compactionEntry: { id: 'c-1' }, fromExtension: false, reason: 'threshold', willRetry: false }, { hasUI: false });
  await fire('session_compact', { compactionEntry: { id: 'c-2' }, fromExtension: false, reason: 'manual', willRetry: false }, { hasUI: false });
  assert.equal(checkpointCards(sent).length, 2);
});

test('no checkpoint card when the compaction will retry (not complete)', async () => {
  const { pi, sent, fire } = makePi();
  registerCompactionHooks(pi, (() => undefined) as never);
  await fire('session_compact', { compactionEntry: { id: 'c-1' }, fromExtension: false, reason: 'overflow', willRetry: true }, { hasUI: false });
  assert.equal(checkpointCards(sent).length, 0);
});

test('checkpoint card label falls back to the reason when the entry has no id', async () => {
  const { pi, sent, fire } = makePi();
  registerCompactionHooks(pi, (() => undefined) as never);
  await fire('session_compact', { compactionEntry: {}, fromExtension: false, reason: 'manual', willRetry: false }, { hasUI: false });
  const cards = checkpointCards(sent);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.content, 'Compaction checkpoint saved: manual compaction');
});
