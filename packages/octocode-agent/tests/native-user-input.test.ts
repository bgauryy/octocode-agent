import { Buffer } from 'node:buffer';

import {
  RUNTIME_USER_INPUT_MAX_IMAGE_BYTES,
  RuntimeFailure,
} from '@octocodeai/agent-core';
import { describe, expect, it, vi } from 'vitest';

import type { NativeFileSystemPort } from '../src/native-file-tool.js';
import {
  NativeComposerImageStore,
  createNativeImageInputResolver,
  parseNativeDraggedImagePath,
} from '../src/native-user-input.js';

const PNG = Buffer.from('iVBORw0KGgoAAA==', 'base64');

function fileSystem(
  readBinary: NativeFileSystemPort['readBinary'],
): NativeFileSystemPort {
  return {
    authorizeExternalPath: vi.fn(),
    readBinary,
    snapshot: vi.fn(),
    replace: vi.fn(),
    delete: vi.fn(),
  };
}

describe('native multimodal input', () => {
  it('verifies binary image metadata and produces a canonical core image part', () => {
    const resolver = createNativeImageInputResolver({
      cwd: '/workspace',
      fileSystem: fileSystem(vi.fn()),
    });

    const image = resolver.fromBinary(PNG, 'image/png', 'pasted.png');
    expect(image).toMatchObject({
      type: 'image',
      mediaType: 'image/png',
      byteLength: PNG.byteLength,
      filename: 'pasted.png',
    });
    expect(image.data.value).toBe(PNG.toString('base64'));
    expect(() => resolver.fromBinary(PNG, 'image/jpeg')).toThrow(
      'does not match',
    );
    expect(() =>
      resolver.fromBinary(
        Buffer.alloc(RUNTIME_USER_INPUT_MAX_IMAGE_BYTES + 1),
        'image/png',
      ),
    ).toThrow('exceeds');
  });

  it('resolves terminal-dropped image paths only through the workspace filesystem capability', async () => {
    const readBinary = vi.fn<NativeFileSystemPort['readBinary']>().mockResolvedValue({
      path: 'screens/example.png',
      contentBase64: PNG.toString('base64'),
      bytes: PNG.byteLength,
      sha256: 'a'.repeat(64),
    });
    const resolver = createNativeImageInputResolver({
      cwd: '/workspace',
      fileSystem: fileSystem(readBinary),
    });

    await expect(
      resolver.fromWorkspacePath("'/workspace/screens/example.png'"),
    ).resolves.toMatchObject({
      type: 'image',
      mediaType: 'image/png',
      filename: 'example.png',
    });
    expect(readBinary).toHaveBeenCalledWith(
      'screens/example.png',
      RUNTIME_USER_INPUT_MAX_IMAGE_BYTES,
      expect.any(AbortSignal),
    );
  });

  it('fails closed for path escape, unsupported files, and missing images without exposing the path', async () => {
    const readBinary = vi.fn<NativeFileSystemPort['readBinary']>();
    const resolver = createNativeImageInputResolver({
      cwd: '/workspace',
      fileSystem: fileSystem(readBinary),
    });

    expect(parseNativeDraggedImagePath('notes.txt')).toBeUndefined();
    await expect(resolver.fromWorkspacePath('../secret.png')).rejects.toEqual(
      expect.objectContaining<Partial<RuntimeFailure>>({
        message: 'Image path must stay within the workspace',
      }),
    );
    expect(readBinary).not.toHaveBeenCalled();

    readBinary.mockResolvedValueOnce(null);
    await expect(resolver.fromWorkspacePath('missing.png')).rejects.toThrow(
      'Image file was not found',
    );
  });

  it('keeps image bytes outside the composer view and restores ordered text/image parts', () => {
    const resolver = createNativeImageInputResolver({
      cwd: '/workspace',
      fileSystem: fileSystem(vi.fn()),
    });
    const store = new NativeComposerImageStore();
    const attachment = store.add(
      resolver.fromBinary(PNG, 'image/png', 'private/path/screenshot.png'.split('/').at(-1)),
    );
    expect(attachment.marker).toContain('screenshot.png');
    expect(attachment.marker).toContain('PNG');
    expect(attachment.marker).not.toContain(PNG.toString('base64'));

    const input = store.compose(`before ${attachment.marker} after`);
    expect(input.parts.map((part) => part.type)).toEqual([
      'text',
      'image',
      'text',
    ]);
    expect(input.parts[0]).toEqual({ type: 'text', text: 'before ' });
    expect(input.parts[2]).toEqual({ type: 'text', text: ' after' });

    const removed = store.compose('text only');
    expect(removed.parts).toEqual([{ type: 'text', text: 'text only' }]);
    expect(store.size).toBe(0);
  });
});
