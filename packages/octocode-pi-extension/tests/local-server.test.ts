/**
 * Tests for the shared CLI local server: multiple named mounts on one loopback
 * port, index-file resolution, content types, 404s, path-traversal refusal, and
 * method guarding.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, test } from 'vitest';
import { Type } from 'typebox';
import {
  serveDirectory,
  unmount,
  stopLocalServer,
  getLocalServerBaseUrl,
} from '../src/tools/local-server.js';
import { registerLocalServerTool } from '../src/tools/local-server-tool.js';
import { registerUniqueTool } from '../src/tools/octocode-tools.js';
import type { ToolDefinition } from '../src/types.js';

afterEach(() => stopLocalServer());

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'octocode-srv-'));
}

async function get(url: string): Promise<{ status: number; body: string; type: string | null }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.text(), type: res.headers.get('content-type') };
}

test('serveDirectory hosts a named mount and serves its index file at the root', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'plan.html'), '<!doctype html><h1>plan</h1>');
  const served = await serveDirectory('plan', dir, { indexFile: 'plan.html' });
  assert.ok(served?.url.startsWith('http://127.0.0.1:'));
  assert.ok(served!.url.endsWith('/plan/'));
  assert.equal(getLocalServerBaseUrl(), served!.url.replace(/plan\/$/, ''));

  const root = await get(served!.url);
  assert.equal(root.status, 200);
  assert.match(root.body, /<h1>plan<\/h1>/);
  assert.match(root.type ?? '', /text\/html/);
});

test('multiple mounts share one loopback port', async () => {
  const planDir = tmpDir();
  const diffDir = tmpDir();
  fs.writeFileSync(path.join(planDir, 'index.html'), 'PLAN');
  fs.writeFileSync(path.join(diffDir, 'index.html'), 'DIFF');
  const plan = await serveDirectory('plan', planDir);
  const diff = await serveDirectory('diff', diffDir);
  assert.equal(new URL(plan!.url).port, new URL(diff!.url).port, 'same port for both mounts');
  assert.equal((await get(plan!.url)).body, 'PLAN');
  assert.equal((await get(diff!.url)).body, 'DIFF');
});

test('serveDirectory serves sub-files with correct content types and 404s the unknown', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'index.html'), 'root');
  fs.writeFileSync(path.join(dir, 'data.json'), '{"ok":true}');
  const served = await serveDirectory('x', dir);
  const json = await get(`${served!.url}data.json`);
  assert.equal(json.status, 200);
  assert.match(json.type ?? '', /application\/json/);
  assert.equal((await get(`${served!.url}missing.css`)).status, 404);
});

test('serveDirectory refuses path traversal and rejects invalid mount names', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'index.html'), 'root');
  const served = await serveDirectory('safe', dir);
  const escape = await get(`${served!.url}../../../../etc/passwd`);
  assert.notEqual(escape.status, 200);

  assert.equal(await serveDirectory('bad/name', dir), undefined, 'slashes are not a valid mount name');
  assert.equal(await serveDirectory('', dir), undefined, 'empty name is invalid');
});

test('serveDirectory does not follow a symlink that escapes the mount', async () => {
  const dir = tmpDir();
  const secretDir = tmpDir();
  fs.writeFileSync(path.join(dir, 'index.html'), 'root');
  fs.writeFileSync(path.join(secretDir, 'passwd'), 'TOPSECRET');
  // A symlink INSIDE the mount pointing at a file outside it.
  fs.symlinkSync(path.join(secretDir, 'passwd'), path.join(dir, 'link'));
  const served = await serveDirectory('sym', dir);
  const via = await get(`${served!.url}link`);
  assert.notEqual(via.status, 200, 'symlink escaping the mount must not be served');
  assert.doesNotMatch(via.body, /TOPSECRET/);
});

test('a request with a foreign Host header is rejected (DNS-rebinding guard)', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'index.html'), 'root');
  const served = await serveDirectory('h', dir);
  const port = Number(new URL(served!.url).port);
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/h/', method: 'GET', headers: { host: 'evil.attacker.com' } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403, 'foreign Host is refused');
});

test('responses carry nosniff and no-store headers', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'index.html'), 'root');
  const served = await serveDirectory('n', dir);
  const res = await fetch(served!.url);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('concurrent serveDirectory calls share one server (no start race)', async () => {
  const a = tmpDir();
  const b = tmpDir();
  fs.writeFileSync(path.join(a, 'index.html'), 'A');
  fs.writeFileSync(path.join(b, 'index.html'), 'B');
  const [sa, sb] = await Promise.all([serveDirectory('a', a), serveDirectory('b', b)]);
  assert.equal(new URL(sa!.url).port, new URL(sb!.url).port, 'one shared port even when started concurrently');
  assert.equal((await get(sa!.url)).body, 'A');
  assert.equal((await get(sb!.url)).body, 'B');
});

test('unmount drops one mount but keeps the shared server for others', async () => {
  const a = tmpDir();
  const b = tmpDir();
  fs.writeFileSync(path.join(a, 'index.html'), 'A');
  fs.writeFileSync(path.join(b, 'index.html'), 'B');
  const sa = await serveDirectory('a', a);
  const sb = await serveDirectory('b', b);
  unmount('a');
  assert.equal((await get(sa!.url)).status, 404, 'unmounted name 404s');
  assert.equal((await get(sb!.url)).body, 'B', 'other mount still served');
});

test('re-mounting a name re-roots it on the same URL', async () => {
  const first = tmpDir();
  const second = tmpDir();
  fs.writeFileSync(path.join(first, 'index.html'), 'FIRST');
  fs.writeFileSync(path.join(second, 'index.html'), 'SECOND');
  const s1 = await serveDirectory('plan', first);
  const s2 = await serveDirectory('plan', second);
  assert.equal(s1!.url, s2!.url, 're-mount keeps the same URL');
  assert.equal((await get(s2!.url)).body, 'SECOND');
});

function loadLocalServerTool(): ToolDefinition {
  const tools = new Map<string, ToolDefinition>();
  const pi = { registerTool: (def: ToolDefinition) => tools.set(def.name, def) };
  registerLocalServerTool(pi, Type, new Set<string>(), registerUniqueTool);
  const tool = tools.get('localServer');
  assert.ok(tool, 'localServer tool registered');
  return tool!;
}

test('localServer tool serves, reports status, unmounts, and stops', async () => {
  const tool = loadLocalServerTool();
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>LOCAL</h1>');
  const serve = await tool.execute('serve', { action: 'serve', name: 'design', dir }, undefined, undefined, { cwd: dir } as never);
  assert.notEqual(serve.isError, true);
  assert.match((serve.content[0] as { text: string }).text, /http:\/\/127\.0\.0\.1:/);
  const url = (serve.details as { url: string }).url;
  assert.equal((await get(url)).body, '<h1>LOCAL</h1>');

  const status = await tool.execute('status', { action: 'status' }, undefined, undefined, { cwd: dir } as never);
  assert.match((status.content[0] as { text: string }).text, /design/);

  await tool.execute('unmount', { action: 'unmount', name: 'design' }, undefined, undefined, { cwd: dir } as never);
  assert.equal((await get(url)).status, 404);

  await tool.execute('stop', { action: 'stop' }, undefined, undefined, { cwd: dir } as never);
  assert.equal(getLocalServerBaseUrl(), undefined);
});

test('localServer tool path-guards served directories and rejects invalid mounts', async () => {
  const tool = loadLocalServerTool();
  const dir = tmpDir();
  const badName = await tool.execute('bad-name', { action: 'serve', name: 'bad/name', dir }, undefined, undefined, { cwd: dir } as never);
  assert.equal(badName.isError, true);
  assert.match((badName.content[0] as { text: string }).text, /could not mount|invalid/i);

  const outside = await tool.execute('outside', { action: 'serve', name: 'x', dir: '/usr' }, undefined, undefined, { cwd: dir } as never);
  assert.equal(outside.isError, true);
  assert.match((outside.content[0] as { text: string }).text, /blocked|outside the allowed roots/);
});
