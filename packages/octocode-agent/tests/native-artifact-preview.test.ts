import http from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ArtifactDescriptorV1 } from '@octocodeai/agent-core';

import {
  assertNativeArtifactPreviewManifestV1,
  createNativeArtifactPreviewController,
  type NativeArtifactPreviewController,
} from '../src/native-artifact-preview.js';
import type { NativeFileSystemPort } from '../src/native-file-tool.js';

const active: NativeArtifactPreviewController[] = [];

afterEach(async () => {
  await Promise.all(active.splice(0).map((controller) => controller.close()));
});

function artifact(bytes: Buffer, overrides: Partial<ArtifactDescriptorV1> = {}): ArtifactDescriptorV1 {
  return {
    schemaVersion: 1,
    artifactId: 'preview-image',
    kind: 'image',
    path: 'artifacts/preview.png',
    mediaType: 'image/png',
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    title: 'Preview image',
    ...overrides,
  };
}

function fileSystem(bytes: Buffer, descriptor: ArtifactDescriptorV1): NativeFileSystemPort {
  return {
    authorizeExternalPath: vi.fn(),
    readBinary: vi.fn(async (requested) => requested === descriptor.path ? {
      path: descriptor.path,
      contentBase64: bytes.toString('base64'),
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    } : null),
    snapshot: vi.fn(), replace: vi.fn(), delete: vi.fn(),
  };
}

function request(
  url: string,
  options: { readonly method?: string; readonly headers?: Readonly<Record<string, string>> } = {},
): Promise<{ readonly status: number; readonly headers: http.IncomingHttpHeaders; readonly body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    req.end();
  });
}

describe('native artifact preview manifest', () => {
  it('strictly validates a bounded, unique artifact allowlist', () => {
    const bytes = Buffer.from('png');
    const descriptor = artifact(bytes);
    const manifest = assertNativeArtifactPreviewManifestV1({ schemaVersion: 1, artifacts: [descriptor] });
    expect(manifest.artifacts).toEqual([descriptor]);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(() => assertNativeArtifactPreviewManifestV1({ schemaVersion: 1, artifacts: [descriptor], extra: true }))
      .toThrow(/field/i);
    expect(() => assertNativeArtifactPreviewManifestV1({ schemaVersion: 1, artifacts: [descriptor, descriptor] }))
      .toThrow(/duplicate/i);
    expect(() => assertNativeArtifactPreviewManifestV1({ schemaVersion: 1, artifacts: [] }))
      .toThrow(/artifacts/i);
  });
});

describe('native artifact preview controller', () => {
  it('serves only exact manifest routes over loopback GET/HEAD with hardened headers', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const descriptor = artifact(bytes);
    const fs = fileSystem(bytes, descriptor);
    const controller = createNativeArtifactPreviewController({
      fileSystem: fs,
      manifest: { schemaVersion: 1, artifacts: [descriptor] },
    });
    active.push(controller);
    const url = await controller.urlFor(descriptor.artifactId);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/preview\/[A-Za-z0-9_-]+\/artifacts\/preview-image$/u);

    const get = await request(url);
    expect(get.status).toBe(200);
    expect(get.body).toEqual(bytes);
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.headers['content-length']).toBe(String(bytes.byteLength));
    expect(get.headers['cache-control']).toBe('no-store');
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect(get.headers['content-security-policy']).toContain("default-src 'none'");
    expect(get.headers['content-security-policy']).toContain('sandbox');
    expect(get.headers['referrer-policy']).toBe('no-referrer');
    expect(get.headers['cross-origin-resource-policy']).toBe('same-origin');

    const head = await request(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(bytes.byteLength));
    expect(head.body.byteLength).toBe(0);
    expect(fs.readBinary).toHaveBeenCalledTimes(2);
  });

  it('rejects host confusion, traversal spellings, unknown files, queries, and non-read methods before filesystem access', async () => {
    const bytes = Buffer.from('artifact');
    const descriptor = artifact(bytes);
    const fs = fileSystem(bytes, descriptor);
    const controller = createNativeArtifactPreviewController({
      fileSystem: fs,
      manifest: { schemaVersion: 1, artifacts: [descriptor] },
    });
    active.push(controller);
    const url = await controller.urlFor(descriptor.artifactId);
    const origin = new URL(url).origin;

    expect((await request(url, { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await request(`${origin}/artifacts/%2e%2e/secret`)).status).toBe(404);
    expect((await request(`${origin}/artifacts/unknown`)).status).toBe(404);
    expect((await request(`${url}?path=../secret`)).status).toBe(404);
    const post = await request(url, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
    expect(fs.readBinary).not.toHaveBeenCalled();
  });

  it('fails closed when artifact bytes drift from the manifest digest or size', async () => {
    const declared = Buffer.from('declared');
    const actual = Buffer.from('changed');
    const descriptor = artifact(declared);
    const controller = createNativeArtifactPreviewController({
      fileSystem: fileSystem(actual, descriptor),
      manifest: { schemaVersion: 1, artifacts: [descriptor] },
    });
    active.push(controller);
    const response = await request(await controller.urlFor(descriptor.artifactId));
    expect(response.status).toBe(409);
    expect(response.body.toString('utf8')).toBe('artifact changed');
    expect(response.body.toString('utf8')).not.toContain(descriptor.sha256);
  });

  it('reuses one server and tears it down deterministically', async () => {
    const bytes = Buffer.from('artifact');
    const descriptor = artifact(bytes);
    const controller = createNativeArtifactPreviewController({
      fileSystem: fileSystem(bytes, descriptor),
      manifest: { schemaVersion: 1, artifacts: [descriptor] },
    });
    active.push(controller);
    const [first, second] = await Promise.all([
      controller.urlFor(descriptor.artifactId),
      controller.urlFor(descriptor.artifactId),
    ]);
    expect(second).toBe(first);
    await controller.close();
    active.splice(active.indexOf(controller), 1);
    await expect(request(first)).rejects.toThrow();
  });
});
