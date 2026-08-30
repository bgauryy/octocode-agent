import {
  BoxRenderable,
  DiffRenderable,
  LineNumberRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  TextTableRenderable,
} from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { describe, expect, it } from 'vitest';

import { OpenTuiSemanticAdapter } from '../src/terminal/opentui/opentui-adapter.js';
import type { WidgetRenderState } from '../src/terminal/opentui/widgets/contracts.js';

const hasNativeFfi = process.execArgv.includes('--experimental-ffi')
  || process.env.NODE_OPTIONS?.split(/\s+/u).includes('--experimental-ffi') === true;

const describeNativeFfi = hasNativeFfi ? describe : describe.skip;

function state(
  id: string,
  kind: string,
  regions: WidgetRenderState['regions'],
  revision = 1,
): WidgetRenderState {
  return {
    id,
    kind,
    lifecycle: 'active',
    revision,
    focused: false,
    capabilities: { focusable: true, inputMode: 'keys' },
    accessibility: {
      role: kind === 'transcript' ? 'log' : 'region',
      label: kind === 'transcript' ? 'Conversation' : 'Runtime presentation',
      liveRegion: kind === 'transcript' ? 'polite' : 'off',
      keyboardHelp: [],
    },
    regions,
  };
}

describeNativeFfi('OpenTUI rich semantic integration', () => {
  it('keeps one Markdown renderable identity while transcript content streams', async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const root = new BoxRenderable(setup.renderer, { id: 'root', width: '100%', height: '100%' });
    const transcript = new BoxRenderable(setup.renderer, { id: 'transcript-slot', width: '100%', height: '100%' });
    root.add(transcript);
    setup.renderer.root.add(root);
    const adapter = new OpenTuiSemanticAdapter(setup.renderer, {
      header: root, transcript, tools: root, sidebar: root, editor: root, footer: root,
    });

    adapter.render(state('transcript', 'transcript', [
      { id: 'messages', role: 'content', text: 'assistant [streaming]: **Hello**\n```ts\nconst value = 1\n```' },
    ]));
    await setup.flush();
    const first = setup.renderer.root.findDescendantById('transcript-rich-content');
    expect(first).toBeInstanceOf(MarkdownRenderable);

    adapter.render(state('transcript', 'transcript', [
      { id: 'messages', role: 'content', text: 'assistant [complete]: **Hello world**\n```ts\nconst value = 2\n```' },
    ], 2));
    await setup.flush();
    expect(setup.renderer.root.findDescendantById('transcript-rich-content')).toBe(first);

    adapter.destroy('transcript');
    setup.renderer.destroy();
  });

  it('keeps short plain transcript lines on the synchronous semantic path', async () => {
    const setup = await createTestRenderer({ width: 80, height: 20 });
    const root = new BoxRenderable(setup.renderer, { id: 'root', width: '100%', height: '100%' });
    setup.renderer.root.add(root);
    const adapter = new OpenTuiSemanticAdapter(setup.renderer, {
      header: root, transcript: root, tools: root, sidebar: root, editor: root, footer: root,
    });

    adapter.render(state('transcript', 'transcript', [
      { id: 'messages', role: 'content', text: 'assistant: Accessible hello' },
    ]));
    await setup.flush();
    expect(setup.renderer.root.findDescendantById('transcript-rich-content')).toBeUndefined();
    expect(setup.captureCharFrame()).toContain('Accessible hello');

    adapter.destroy('transcript');
    setup.renderer.destroy();
  });

  it('dispatches code, diff, and structured rows to their native primitives', async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 });
    const root = new BoxRenderable(setup.renderer, { id: 'root', width: '100%', height: '100%', flexDirection: 'column' });
    const slot = new ScrollBoxRenderable(setup.renderer, { id: 'slot', width: '100%', height: '100%' });
    root.add(slot);
    setup.renderer.root.add(root);
    const adapter = new OpenTuiSemanticAdapter(setup.renderer, {
      header: root, transcript: root, tools: root, sidebar: slot, editor: root, footer: root,
    });

    adapter.render(state('code-surface', 'presentation-surface', [
      { id: 'summary', role: 'status', text: 'Presentation code · revision 1 · Text' },
      { id: 'content', role: 'content', text: '```typescript\nconst answer = 42\n```' },
    ]));
    adapter.render(state('diff-surface', 'presentation-surface', [
      { id: 'summary', role: 'status', text: 'Presentation patch · revision 1 · Text' },
      { id: 'content', role: 'content', text: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new' },
    ]));
    adapter.render(state('table-surface', 'presentation-surface', [
      { id: 'summary', role: 'status', text: 'Presentation facts · revision 1 · Key-value' },
      { id: 'content', role: 'content', text: 'Model: gpt-5\nState: ready' },
    ]));
    await setup.flush();

    expect(setup.renderer.root.findDescendantById('code-surface-rich-content')).toBeInstanceOf(LineNumberRenderable);
    expect(setup.renderer.root.findDescendantById('diff-surface-rich-content')).toBeInstanceOf(DiffRenderable);
    expect(setup.renderer.root.findDescendantById('table-surface-rich-content')).toBeInstanceOf(TextTableRenderable);

    adapter.destroy('code-surface');
    adapter.destroy('diff-surface');
    adapter.destroy('table-surface');
    setup.renderer.destroy();
  });

  it('keeps explicit semantic markers when terminal color is disabled', async () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    const setup = await createTestRenderer({ width: 80, height: 12 });
    try {
      const root = new BoxRenderable(setup.renderer, { id: 'root', width: '100%', height: '100%' });
      setup.renderer.root.add(root);
      const adapter = new OpenTuiSemanticAdapter(setup.renderer, {
        header: root, transcript: root, tools: root, sidebar: root, editor: root, footer: root,
      });
      adapter.render(state('status', 'status.notifications', [
        { id: 'warning', role: 'status', text: 'WARNING: Context nearly full' },
      ]));
      await setup.flush();
      expect(setup.captureCharFrame()).toContain('! WARNING: Context nearly full');
      adapter.destroy('status');
    } finally {
      setup.renderer.destroy();
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });
});
