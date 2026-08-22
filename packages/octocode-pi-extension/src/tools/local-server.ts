/**
 * local-server — one shared localhost static server for every CLI HTML surface.
 *
 * Some data reads better in a browser than a terminal (plans as diagrams, diffs,
 * worker timelines, reports). Any feature can mount a directory under a named
 * path and get back a `http://127.0.0.1:<port>/<name>/` URL to open; the browser
 * loads a real hosted page (meta-refresh live-reloads, relative assets resolve)
 * instead of a bare `file://` path.
 *
 * Design:
 *   - ONE server per process, lazily started on the first mount, bound to
 *     loopback (127.0.0.1) on an OS-assigned ephemeral port, and `unref`'d so it
 *     never keeps the process alive.
 *   - Multiple named mounts share the one port: `serveDirectory('plan', dir)` →
 *     `…/plan/`, `serveDirectory('diff', dir)` → `…/diff/`. Re-mounting a name
 *     just re-roots it.
 *   - Read-only. Every request is path-guarded to its mount directory (no
 *     traversal) and served `no-store` so live surfaces always fetch fresh.
 *
 * It serves LOCAL, agent-generated files to the local user's browser only — it is
 * not a public server and binds loopback deliberately.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export interface LocalMount {
  /** Absolute directory served under this mount. */
  dir: string;
  /** File served when the request targets the mount root. */
  indexFile: string;
}

export interface ServedMount {
  name: string;
  /** Absolute URL to open, e.g. `http://127.0.0.1:51668/plan/`. */
  url: string;
}

export interface LocalServerMountInfo extends LocalMount {
  name: string;
}

/** Mount names must be a single safe URL path segment. */
const MOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const mounts = new Map<string, LocalMount>();
let server: http.Server | undefined;
let baseUrl: string | undefined;
let serverPort = 0;
/** In-flight start promise — memoized so concurrent serveDirectory calls share one server. */
let starting: Promise<string | undefined> | undefined;

function contentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolve `rel` inside `dir`, returning undefined if it escapes the directory.
 * `rel` is treated as always-relative (leading slashes stripped) and the
 * resolved path must equal `dir` or sit strictly beneath it.
 */
function resolveWithin(dir: string, rel: string): string | undefined {
  const base = path.resolve(dir);
  const target = path.resolve(base, rel.replace(/^[/\\]+/, ''));
  if (target !== base && !target.startsWith(base + path.sep)) return undefined;
  return target;
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const send = (status: number, body: string): void => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  };
  try {
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
      send(405, 'method not allowed');
      return;
    }
    // Host allowlist: defeats DNS-rebinding (a remote page that rebinds its
    // hostname to 127.0.0.1:<port> would otherwise be same-origin). Only the
    // loopback names for our exact port are accepted.
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${serverPort}` && host !== `localhost:${serverPort}` && host !== `[::1]:${serverPort}`) {
      send(403, 'forbidden');
      return;
    }
    const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const segments = rawPath.split('/').filter(Boolean);
    const name = segments.shift();
    const mount = name ? mounts.get(name) : undefined;
    if (!mount) {
      send(404, 'not found');
      return;
    }
    const rel = segments.length > 0 ? segments.join('/') : mount.indexFile;
    const file = resolveWithin(mount.dir, rel);
    if (!file) {
      send(403, 'forbidden');
      return;
    }
    // realpath BOTH the target and the mount root, then re-check containment:
    // the lexical guard above can't see a symlink inside the mount that points
    // out of it. If either realpath fails (missing file) → 404; if the real
    // target escapes the real mount dir → 403.
    fs.realpath(mount.dir, (baseErr, realBase) => {
      if (baseErr) {
        send(404, 'not found');
        return;
      }
      fs.realpath(file, (fileErr, realFile) => {
        if (fileErr) {
          send(404, 'not found');
          return;
        }
        if (realFile !== realBase && !realFile.startsWith(realBase + path.sep)) {
          send(403, 'forbidden');
          return;
        }
        fs.readFile(realFile, (err, data) => {
          if (err) {
            send(404, 'not found');
            return;
          }
          res.writeHead(200, {
            'content-type': contentType(realFile),
            // Live surfaces rewrite files in place; never let the browser cache them.
            'cache-control': 'no-store',
            // Agent-generated content — never let the browser sniff a different type.
            'x-content-type-options': 'nosniff',
          });
          res.end(req.method === 'HEAD' ? undefined : data);
        });
      });
    });
  } catch {
    send(400, 'bad request');
  }
}

/** Lazily start the shared loopback server; returns its base URL or undefined. */
async function ensureServer(): Promise<string | undefined> {
  if (baseUrl) return baseUrl;
  // Memoize the in-flight start so two overlapping serveDirectory calls don't
  // each create a server (which would orphan one and desync baseUrl).
  if (starting) return starting;
  starting = (async (): Promise<string | undefined> => {
    try {
      const s = http.createServer(handleRequest);
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => resolve());
      });
      s.unref();
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      if (!port) {
        s.close();
        return undefined;
      }
      server = s;
      serverPort = port;
      baseUrl = `http://127.0.0.1:${port}/`;
      return baseUrl;
    } catch {
      return undefined;
    } finally {
      starting = undefined;
    }
  })();
  return starting;
}

/**
 * Mount `dir` under `/<name>/` on the shared server and return the URL to open.
 * Re-mounting an existing name re-roots it. Returns undefined if the name is
 * invalid or the server could not start.
 *
 * The caller owns `dir`: it must exist before requests arrive (mount registers
 * immediately; a missing dir surfaces as a per-request 404, not a mount error).
 * This serves STATIC files only — dynamic surfaces (SSE/streaming) would need a
 * separate handler API.
 */
export async function serveDirectory(
  name: string,
  dir: string,
  opts?: { indexFile?: string },
): Promise<ServedMount | undefined> {
  if (!MOUNT_NAME.test(name)) return undefined;
  mounts.set(name, { dir: path.resolve(dir), indexFile: opts?.indexFile ?? 'index.html' });
  const base = await ensureServer();
  if (!base) {
    mounts.delete(name);
    return undefined;
  }
  return { name, url: `${base}${name}/` };
}

/** Remove a single mount (the shared server keeps running for other mounts). */
export function unmount(name: string): void {
  mounts.delete(name);
}

/** Stop the shared server and drop all mounts. */
export function stopLocalServer(): void {
  if (server) {
    try {
      server.close();
    } catch {
      /* already closed */
    }
  }
  server = undefined;
  baseUrl = undefined;
  serverPort = 0;
  starting = undefined;
  mounts.clear();
}

/** Base URL of the shared server, or undefined when it is not running. */
export function getLocalServerBaseUrl(): string | undefined {
  return baseUrl;
}

/** Snapshot of current mounts for status/tool rendering. */
export function listLocalServerMounts(): LocalServerMountInfo[] {
  return [...mounts.entries()].map(([name, mount]) => ({ name, ...mount }));
}
