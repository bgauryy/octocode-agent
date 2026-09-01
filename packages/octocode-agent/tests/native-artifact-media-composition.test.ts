import { describe, expect, it, vi } from 'vitest';

import { createDefaultOctocodeToolRegistry } from '../src/native-tools.js';
import type { NativeFileSystemPort } from '../src/native-file-tool.js';

describe('native artifact media production composition', () => {
  it('registers only when the delegated filesystem capability is present', async () => {
    const fileSystem: NativeFileSystemPort = {
      authorizeExternalPath: vi.fn(), readBinary: vi.fn(), snapshot: vi.fn(), replace: vi.fn(), delete: vi.fn(),
    };
    const registry = await createDefaultOctocodeToolRegistry({
      cwd: process.cwd(),
      run: async () => JSON.stringify({ kind: 'octocode.toolCatalog.full', version: 1, toolCount: 0, tools: [] }),
      allowedTools: new Set(['artifactMedia']),
      file: { fileSystem },
      artifactMedia: { resolveBinary: (name) => `/opt/bin/${name}`, process: { run: vi.fn() } },
    });
    expect(registry.list().map(({ name }) => name)).toEqual(['artifactMedia']);
  });
});
