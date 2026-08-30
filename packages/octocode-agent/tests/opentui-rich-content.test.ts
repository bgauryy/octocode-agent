import {
  BoxRenderable,
  CodeRenderable,
  DiffRenderable,
  LineNumberRenderable,
  MarkdownRenderable,
  TextTableRenderable,
} from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { describe, expect, it } from 'vitest';

import { mountOpenTuiRichContent } from '../src/terminal/opentui/rich-content.js';

const hasNativeFfi = process.execArgv.includes('--experimental-ffi')
  || process.env.NODE_OPTIONS?.split(/\s+/u).includes('--experimental-ffi') === true;

const describeNativeFfi = hasNativeFfi ? describe : describe.skip;

describeNativeFfi('OpenTUI rich content factory (requires NODE_OPTIONS=--experimental-ffi)', () => {
  it('mounts, updates, and destroys markdown content', async () => {
    const setup = await createTestRenderer({ width: 60, height: 12 });
    const host = new BoxRenderable(setup.renderer, { id: 'host', width: '100%', height: '100%' });
    setup.renderer.root.add(host);

    const mounted = mountOpenTuiRichContent(setup.renderer, host, {
      kind: 'markdown', id: 'body', content: '# Before',
    });
    expect(mounted.root).toBeInstanceOf(MarkdownRenderable);
    mounted.update({ kind: 'markdown', id: 'body', content: '**After**' });
    expect(mounted.root.id).toBe('body');
    await setup.flush();
    expect((mounted.root as MarkdownRenderable).content).toBe('**After**');

    mounted.destroy();
    expect(mounted.root.isDestroyed).toBe(true);
    expect(host.findDescendantById('body')).toBeUndefined();
    setup.renderer.destroy();
  });

  it('mounts code inside a line-number gutter and safely drops unknown languages', async () => {
    const setup = await createTestRenderer({ width: 60, height: 12 });
    const host = new BoxRenderable(setup.renderer, { id: 'host', width: '100%' });
    setup.renderer.root.add(host);

    const mounted = mountOpenTuiRichContent(setup.renderer, host, {
      kind: 'code', id: 'source', content: 'const before = 1;', language: 'typescript',
    });
    expect(mounted.root).toBeInstanceOf(LineNumberRenderable);
    const code = mounted.root.findDescendantById('source-code') as CodeRenderable;
    expect(code).toBeInstanceOf(CodeRenderable);
    expect(code.filetype).toBe('typescript');

    mounted.update({
      kind: 'code', id: 'source', content: '<still plain>', language: '../../not-a-language',
    });
    expect(code.content).toBe('<still plain>');
    expect(code.filetype).toBeUndefined();
    mounted.update({ kind: 'code', id: 'source', content: 'unknown()', language: 'definitely-unknown' });
    expect(code.filetype).toBeUndefined();
    await setup.flush();
    expect(setup.captureCharFrame()).toContain('unknown()');

    mounted.destroy();
    expect(mounted.root.isDestroyed).toBe(true);
    setup.renderer.destroy();
  });

  it('mounts, updates, and destroys a unified diff', async () => {
    const setup = await createTestRenderer({ width: 70, height: 14 });
    const host = new BoxRenderable(setup.renderer, { id: 'host', width: '100%' });
    setup.renderer.root.add(host);
    const before = '@@ -1 +1 @@\n-before\n+after';
    const after = '@@ -1 +1 @@\n-old\n+new';

    const mounted = mountOpenTuiRichContent(setup.renderer, host, {
      kind: 'diff', id: 'patch', content: before, language: 'text', view: 'unified',
    });
    expect(mounted.root).toBeInstanceOf(DiffRenderable);
    mounted.update({ kind: 'diff', id: 'patch', content: after, language: 'not/valid' });
    expect((mounted.root as DiffRenderable).diff).toBe(after);
    expect((mounted.root as DiffRenderable).filetype).toBeUndefined();
    await setup.flush();

    mounted.destroy();
    expect(mounted.root.isDestroyed).toBe(true);
    setup.renderer.destroy();
  });

  it('mounts, updates, and destroys a text table', async () => {
    const setup = await createTestRenderer({ width: 60, height: 12 });
    const host = new BoxRenderable(setup.renderer, { id: 'host', width: '100%' });
    setup.renderer.root.add(host);

    const mounted = mountOpenTuiRichContent(setup.renderer, host, {
      kind: 'table', id: 'facts', rows: [['Name', 'State'], ['build', 'pending']],
    });
    expect(mounted.root).toBeInstanceOf(TextTableRenderable);
    mounted.update({ kind: 'table', id: 'facts', rows: [['Name', 'State'], ['build', 'passed']] });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain('passed');

    mounted.destroy();
    expect(mounted.root.isDestroyed).toBe(true);
    setup.renderer.destroy();
  });

  it('rejects updates that would change the mounted primitive kind', async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const host = new BoxRenderable(setup.renderer, { id: 'host' });
    setup.renderer.root.add(host);
    const mounted = mountOpenTuiRichContent(setup.renderer, host, {
      kind: 'markdown', id: 'fixed', content: 'same primitive',
    });

    expect(() => mounted.update({ kind: 'table', id: 'fixed', rows: [['different']] }))
      .toThrow(/cannot change rich content kind/u);
    mounted.destroy();
    setup.renderer.destroy();
  });
});
