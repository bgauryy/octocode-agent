import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { closeNativeToolRegistry, createDefaultOctocodeToolRegistry } from '../src/native-tools.js';
import type { NativeFileSystemPort } from '../src/native-file-tool.js';

describe('native artifact preview workflow', () => {
  it('opens a capability URL without persisting it in the tool receipt and closes through registry lifecycle', async () => {
    const bytes = Buffer.from('preview');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let openedUrl = '';
    const fileSystem: NativeFileSystemPort = {
      authorizeExternalPath: vi.fn(),
      readBinary: vi.fn(async () => ({ path: 'artifact.txt', contentBase64: bytes.toString('base64'), bytes: bytes.length, sha256 })),
      snapshot: vi.fn(), replace: vi.fn(), delete: vi.fn(),
    };
    const registry = await createDefaultOctocodeToolRegistry({
      cwd: process.cwd(),
      run: async () => JSON.stringify({ kind: 'octocode.toolCatalog.full', version: 1, toolCount: 0, tools: [] }),
      allowedTools: new Set(['artifactPreview']),
      file: { fileSystem },
      artifactPreview: {
        openUrl: async (url) => {
          openedUrl = url;
          const response = await fetch(url);
          return { ok: response.status === 200 && await response.text() === 'preview' };
        },
      },
    });
    const tool = registry.get('artifactPreview')!;
    const run = (input: unknown) => tool.execute({ input, signal: new AbortController().signal, update: async () => undefined } as never);
    const opened = await run({
      action: 'open',
      manifest: { schemaVersion: 1, artifacts: [{
        schemaVersion: 1, artifactId: 'artifact-preview', kind: 'document', path: 'artifact.txt',
        mediaType: 'text/plain', byteLength: bytes.length, sha256, title: 'Preview',
      }] },
    });
    expect(opened.content).toMatchObject({ state: 'opened', artifactCount: 1 });
    expect(openedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/preview\/[A-Za-z0-9_-]+\/artifacts\/artifact-preview$/);
    expect(JSON.stringify(opened)).not.toContain('/preview/');
    expect((await run({ action: 'status' })).content).toMatchObject({ active: [{ artifactCount: 1 }] });
    await closeNativeToolRegistry(registry);
    await expect(fetch(openedUrl)).rejects.toThrow();
  });
});
