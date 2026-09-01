import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

import {
  RuntimeFailure,
  assertArtifactDescriptorV1,
  type ArtifactDescriptorV1,
} from '@octocodeai/agent-core';

import type { NativeFileSystemPort } from './native-file-tool.js';

export const NATIVE_ARTIFACT_PREVIEW_MAX_ARTIFACTS = 64;
export const NATIVE_ARTIFACT_PREVIEW_MAX_BYTES = 64 * 1_048_576;

export interface NativeArtifactPreviewManifestV1 {
  readonly schemaVersion: 1;
  readonly artifacts: readonly ArtifactDescriptorV1[];
}

export interface NativeArtifactPreviewController {
  urlFor(artifactId: string): Promise<string>;
  close(): Promise<void>;
}

export interface NativeArtifactPreviewOptions {
  readonly fileSystem: NativeFileSystemPort;
  readonly manifest: NativeArtifactPreviewManifestV1;
  readonly maxArtifactBytes?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new RuntimeFailure('validation', message);
}

function exactFields(value: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) fail(`Unexpected ${label} field: ${unexpected}`);
}

export function assertNativeArtifactPreviewManifestV1(value: unknown): NativeArtifactPreviewManifestV1 {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.artifacts))
    fail('Artifact preview manifest must use version one');
  exactFields(value, ['schemaVersion', 'artifacts'], 'artifact preview manifest');
  if (value.artifacts.length === 0 || value.artifacts.length > NATIVE_ARTIFACT_PREVIEW_MAX_ARTIFACTS)
    fail(`Artifact preview manifest must contain 1-${NATIVE_ARTIFACT_PREVIEW_MAX_ARTIFACTS} artifacts`);
  const artifacts = value.artifacts.map(assertArtifactDescriptorV1);
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const artifact of artifacts) {
    if (ids.has(artifact.artifactId)) fail('Artifact preview manifest contains a duplicate artifactId');
    if (paths.has(artifact.path)) fail('Artifact preview manifest contains a duplicate artifact path');
    ids.add(artifact.artifactId);
    paths.add(artifact.path);
  }
  return Object.freeze({ schemaVersion: 1, artifacts: Object.freeze(artifacts) });
}

const CSP = "default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; connect-src 'none'";

function commonHeaders(contentType: string): Readonly<Record<string, string>> {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': CSP,
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'x-frame-options': 'DENY',
  };
}

function send(
  response: http.ServerResponse,
  method: string | undefined,
  status: number,
  body: string,
  extra: Readonly<Record<string, string>> = {},
): void {
  const bytes = Buffer.from(body, 'utf8');
  response.writeHead(status, {
    ...commonHeaders('text/plain; charset=utf-8'),
    'content-length': String(bytes.byteLength),
    ...extra,
  });
  response.end(method === 'HEAD' ? undefined : bytes);
}

function filename(value: string): string {
  const basename = path.posix.basename(value).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120);
  return basename || 'artifact';
}

export function createNativeArtifactPreviewController(
  options: NativeArtifactPreviewOptions,
): NativeArtifactPreviewController {
  const manifest = assertNativeArtifactPreviewManifestV1(options.manifest);
  const maximum = options.maxArtifactBytes ?? NATIVE_ARTIFACT_PREVIEW_MAX_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > NATIVE_ARTIFACT_PREVIEW_MAX_BYTES)
    fail(`Artifact preview byte limit must be between 1 and ${NATIVE_ARTIFACT_PREVIEW_MAX_BYTES}`);
  for (const artifact of manifest.artifacts) {
    if (artifact.byteLength > maximum)
      fail(`Artifact ${artifact.artifactId} exceeds the preview byte limit`);
  }
  const byId = new Map(manifest.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const capabilityPath = `/preview/${randomBytes(24).toString('base64url')}`;
  const routeById = new Map(manifest.artifacts.map((artifact) => [
    artifact.artifactId,
    `${capabilityPath}/artifacts/${encodeURIComponent(artifact.artifactId)}`,
  ]));
  const byRoute = new Map(manifest.artifacts.map((artifact) => [routeById.get(artifact.artifactId)!, artifact]));
  let server: http.Server | undefined;
  let origin: string | undefined;
  let starting: Promise<string> | undefined;
  let disposed = false;

  const start = (): Promise<string> => {
    if (disposed) return Promise.reject(new RuntimeFailure('cancelled', 'Artifact preview is closed'));
    if (origin !== undefined) return Promise.resolve(origin);
    if (starting !== undefined) return starting;
    const pending = new Promise<string>((resolve, reject) => {
      const candidate = http.createServer(async (request, response) => {
        const expectedHost = origin === undefined ? '' : new URL(origin).host;
        if ((request.headers.host ?? '').toLowerCase() !== expectedHost.toLowerCase()) {
          send(response, request.method, 403, 'forbidden');
          return;
        }
        const rawTarget = request.url ?? '';
        const artifact = byRoute.get(rawTarget);
        if (artifact === undefined) {
          send(response, request.method, 404, 'not found');
          return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          send(response, request.method, 405, 'method not allowed', { allow: 'GET, HEAD' });
          return;
        }
        try {
          const snapshot = await options.fileSystem.readBinary(artifact.path, maximum, AbortSignal.timeout(30_000));
          if (snapshot === null) {
            send(response, request.method, 404, 'not found');
            return;
          }
          const bytes = Buffer.from(snapshot.contentBase64, 'base64');
          const digest = createHash('sha256').update(bytes).digest('hex');
          if (
            bytes.toString('base64') !== snapshot.contentBase64
            || snapshot.path !== artifact.path
            || snapshot.bytes !== bytes.byteLength
            || snapshot.sha256 !== digest
            || artifact.byteLength !== snapshot.bytes
            || artifact.sha256 !== snapshot.sha256
          ) {
            send(response, request.method, 409, 'artifact changed');
            return;
          }
          response.writeHead(200, {
            ...commonHeaders(artifact.mediaType),
            'content-length': String(bytes.byteLength),
            'content-disposition': `inline; filename="${filename(artifact.path)}"`,
            etag: `"sha256-${artifact.sha256}"`,
          });
          response.end(request.method === 'HEAD' ? undefined : bytes);
        } catch {
          if (!response.headersSent) send(response, request.method, 500, 'preview unavailable');
          else response.destroy();
        }
      });
      candidate.once('error', reject);
      candidate.listen(0, '127.0.0.1', () => {
        const address = candidate.address();
        if (address === null || typeof address === 'string') {
          candidate.close();
          reject(new RuntimeFailure('internal-invariant', 'Could not resolve artifact preview address'));
          return;
        }
        server = candidate;
        origin = `http://127.0.0.1:${address.port}`;
        candidate.unref();
        resolve(origin);
      });
    }).finally(() => { starting = undefined; });
    starting = pending;
    return pending;
  };

  return Object.freeze({
    async urlFor(artifactId: string) {
      if (!byId.has(artifactId)) throw new RuntimeFailure('validation', 'Artifact is not present in the preview manifest');
      const base = await start();
      return `${base}${routeById.get(artifactId)!}`;
    },
    async close() {
      disposed = true;
      if (starting !== undefined) {
        try { await starting; } catch { return; }
      }
      const active = server;
      server = undefined;
      origin = undefined;
      if (active === undefined) return;
      await new Promise<void>((resolve, reject) => {
        active.close((error) => error ? reject(error) : resolve());
        active.closeAllConnections?.();
      });
    },
  });
}
