import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  OCTOCODE_MCP_ENV_DEFAULTS,
  patchGlobalMcpOctocodeEnv,
  resolveMcpCallText,
} from '../src/tools/mcp-tool.js';

function tmpMcpJson(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-'));
  const p = path.join(dir, 'mcp.json');
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return p;
}

// ─── OCTOCODE_MCP_ENV_DEFAULTS contract ──────────────────────────────────────

test('env defaults: full-text MCP responses + local tools + npm cache vars are always on for the octocode server', () => {
  assert.equal(OCTOCODE_MCP_ENV_DEFAULTS['OCTOCODE_MCP_FULL_TEXT'], 'true');
  assert.equal(OCTOCODE_MCP_ENV_DEFAULTS['ENABLE_LOCAL'], 'true');
  assert.equal(OCTOCODE_MCP_ENV_DEFAULTS['npm_config_include'], 'optional');
  assert.ok(OCTOCODE_MCP_ENV_DEFAULTS['npm_config_cache']!.length > 0);
});

// ─── patchGlobalMcpOctocodeEnv ───────────────────────────────────────────────

test('patch: adds missing env vars (incl. OCTOCODE_MCP_FULL_TEXT, ENABLE_LOCAL) to the octocode server entry', () => {
  const p = tmpMcpJson({ mcpServers: { octocode: { command: 'node', args: ['x.js'] } } });
  patchGlobalMcpOctocodeEnv(p);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const env = raw.mcpServers.octocode.env;
  assert.equal(env.OCTOCODE_MCP_FULL_TEXT, 'true');
  assert.equal(env.ENABLE_LOCAL, 'true');
  assert.equal(env.npm_config_include, 'optional');
  assert.ok(env.npm_config_cache.length > 0);
});

test('patch: user-supplied env values take precedence', () => {
  const p = tmpMcpJson({
    mcpServers: {
      octocode: {
        command: 'node',
        env: { OCTOCODE_MCP_FULL_TEXT: 'false', npm_config_cache: '/my/cache' },
      },
    },
  });
  patchGlobalMcpOctocodeEnv(p);
  const env = JSON.parse(fs.readFileSync(p, 'utf8')).mcpServers.octocode.env;
  assert.equal(env.OCTOCODE_MCP_FULL_TEXT, 'false', 'user override preserved');
  assert.equal(env.npm_config_cache, '/my/cache', 'user override preserved');
  assert.equal(env.npm_config_include, 'optional', 'missing default still added');
});

test('patch: idempotent — second run does not rewrite the file', () => {
  const p = tmpMcpJson({ mcpServers: { octocode: { command: 'node' } } });
  patchGlobalMcpOctocodeEnv(p);
  const first = fs.statSync(p).mtimeMs;
  const firstContent = fs.readFileSync(p, 'utf8');
  patchGlobalMcpOctocodeEnv(p);
  assert.equal(fs.readFileSync(p, 'utf8'), firstContent);
  assert.equal(fs.statSync(p).mtimeMs, first);
});

test('patch: no-ops safely on missing file, invalid JSON, and missing octocode entry', () => {
  assert.doesNotThrow(() => patchGlobalMcpOctocodeEnv(path.join(os.tmpdir(), 'nope', 'mcp.json')));
  const bad = tmpMcpJson('{not json');
  assert.doesNotThrow(() => patchGlobalMcpOctocodeEnv(bad));
  assert.equal(fs.readFileSync(bad, 'utf8'), '{not json');
  const other = tmpMcpJson({ mcpServers: { other: { command: 'x' } } });
  patchGlobalMcpOctocodeEnv(other);
  assert.deepEqual(JSON.parse(fs.readFileSync(other, 'utf8')), { mcpServers: { other: { command: 'x' } } });
});

// ─── resolveMcpCallText — structuredContent interop fallback ─────────────────

const STUB = 'structuredContent available · results=1 · [q1 ok]. Read structuredContent for full data; if your client cannot read structuredContent, set OCTOCODE_MCP_FULL_TEXT=true.';

test('call text: compact stub + structuredContent → structuredContent is surfaced as text', () => {
  const payload = {
    content: [{ type: 'text', text: STUB }],
    structuredContent: { status: 'ok', results: [{ id: 'q1', data: 'real-data' }] },
  };
  const text = resolveMcpCallText(payload);
  assert.ok(text.includes('real-data'), 'structured data must be visible to the model');
  assert.ok(!text.startsWith('structuredContent available'), 'stub must not lead the output');
});

test('call text: empty content + structuredContent → structuredContent surfaced', () => {
  const text = resolveMcpCallText({ content: [], structuredContent: { hello: 'world' } });
  assert.ok(text.includes('world'));
});

test('call text: normal text content passes through unchanged', () => {
  const payload = {
    content: [{ type: 'text', text: 'plain full result' }],
    structuredContent: { ignored: true },
  };
  assert.ok(resolveMcpCallText(payload).includes('plain full result'));
  assert.ok(!resolveMcpCallText(payload).includes('ignored'));
});

test('call text: stub without structuredContent stays as-is (nothing better available)', () => {
  const payload = { content: [{ type: 'text', text: STUB }] };
  assert.equal(resolveMcpCallText(payload), STUB);
});

test('call text: non-record / malformed payloads stringify without throwing', () => {
  assert.doesNotThrow(() => resolveMcpCallText(null));
  assert.doesNotThrow(() => resolveMcpCallText({ content: 'weird' }));
});

// ─── add / remove server (mcp.json CRUD, no agent restart) ────────────────────
import {
  upsertServerInFile,
  removeServerFromFile,
  configSignature,
} from '../src/tools/mcp-tool.js';

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-crud-'));
}

test('add: creates mcp.json with mcpServers wrapper and only-defined fields', () => {
  const p = path.join(freshDir(), 'mcp.json');
  const parsed = upsertServerInFile(p, 'weather', { command: 'node', args: ['w.js'], env: { KEY: 'v' } });
  assert.equal(parsed.command, 'node');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(raw.mcpServers.weather, { command: 'node', args: ['w.js'], env: { KEY: 'v' } });
});

test('add: preserves the existing container shape (servers key) and other top-level keys', () => {
  const p = tmpMcpJson({ servers: { a: { command: 'x' } }, someOtherKey: 1 });
  upsertServerInFile(p, 'b', { command: 'y' });
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(raw.servers.a && raw.servers.b, 'writes into existing servers container');
  assert.equal(raw.someOtherKey, 1, 'preserves unrelated keys');
});

test('add: updates (upserts) an existing server in place', () => {
  const p = tmpMcpJson({ mcpServers: { s: { command: 'old' } } });
  upsertServerInFile(p, 's', { command: 'new', args: ['--flag'] });
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(raw.mcpServers.s.command, 'new');
  assert.deepEqual(raw.mcpServers.s.args, ['--flag']);
});

test('add: rejects an invalid server name / missing command', () => {
  const p = path.join(freshDir(), 'mcp.json');
  assert.throws(() => upsertServerInFile(p, 'bad name!', { command: 'node' }));
  assert.throws(() => upsertServerInFile(p, 'ok', {} as Record<string, unknown>));
});

test('remove: deletes a server and reports presence', () => {
  const p = tmpMcpJson({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } });
  assert.equal(removeServerFromFile(p, 'a'), true);
  assert.equal(removeServerFromFile(p, 'a'), false, 'second remove is a no-op');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(raw.mcpServers.a, undefined);
  assert.ok(raw.mcpServers.b);
});

test('remove: missing file is a safe no-op', () => {
  assert.equal(removeServerFromFile(path.join(freshDir(), 'nope.json'), 'x'), false);
});

// ─── config-drift signature (drives auto-reconnect without restart) ───────────
test('configSignature changes when command/args/env/cwd/timeout change, stable otherwise', () => {
  const base = { command: 'node', args: ['a'], env: { K: '1' } };
  assert.equal(configSignature(base), configSignature({ ...base }), 'stable for equal config');
  assert.notEqual(configSignature(base), configSignature({ ...base, command: 'deno' }));
  assert.notEqual(configSignature(base), configSignature({ ...base, args: ['b'] }));
  assert.notEqual(configSignature(base), configSignature({ ...base, env: { K: '2' } }));
  assert.notEqual(configSignature(base), configSignature({ ...base, cwd: '/x' }));
});

// ─── TTL freshness, unremovable default, live connect ─────────────────────────
import { isFresh, handleMcpAction } from '../src/tools/mcp-tool.js';

function trustedCtx() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-ctx-'));
  return { cwd, isProjectTrusted: async () => true } as unknown as import('../src/types.js').PiContext;
}

test('TTL: a cache entry is fresh within the window and stale past it', () => {
  const now = 1_000_000_000_000;
  const mk = (cachedAt?: number) => ({ name: 's', tools: [], text: '', cachedAt }) as never;
  assert.equal(isFresh(mk(now), now), true);
  assert.equal(isFresh(mk(now - 5 * 60_000), now), true, 'within 10m TTL');
  assert.equal(isFresh(mk(now - 20 * 60_000), now), false, 'past 10m TTL');
  assert.equal(isFresh(mk(undefined), now), true, 'no timestamp treated as fresh');
});

test('the built-in octocode server cannot be removed (default MCP, no spawn)', async () => {
  const res = await handleMcpAction({ action: 'remove', server: 'octocode' }, undefined, trustedCtx());
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /cannot be removed/i);
});

test('add: overriding octocode notes the shadow of the built-in default', async () => {
  const ctx = trustedCtx();
  const res = await handleMcpAction(
    { action: 'add', server: 'octocode', config: { command: 'npx', args: ['-y', 'octocode-mcp@latest'] } },
    undefined,
    ctx,
  );
  assert.equal(res.isError ?? false, false);
  assert.match(res.content[0]!.text, /overrides the built-in octocode default/i);
  const written = JSON.parse(fs.readFileSync(path.join((ctx as unknown as { cwd: string }).cwd, '.pi', 'agent', 'mcp.json'), 'utf8'));
  assert.equal(written.mcpServers.octocode.command, 'npx');
});

test('add then remove a custom server via handleMcpAction (no agent restart)', async () => {
  const ctx = trustedCtx();
  const add = await handleMcpAction({ action: 'add', server: 'weather', config: { command: 'node', args: ['w.js'] } }, undefined, ctx);
  assert.match(add.content[0]!.text, /added to project mcp.json/i);
  const rm = await handleMcpAction({ action: 'remove', server: 'weather' }, undefined, ctx);
  assert.match(rm.content[0]!.text, /removed from project mcp.json/i);
});

// Live integration — gated (spawns the real octocode MCP server via npx). Run with RUN_MCP_LIVE=1.
const liveTest = process.env.RUN_MCP_LIVE === '1' ? test : test.skip;
liveTest('LIVE: connects to the built-in octocode MCP server via npx and lists tools', { timeout: 120_000 }, async () => {
  const res = await handleMcpAction({ action: 'list', server: 'octocode' }, undefined, trustedCtx());
  assert.equal(res.isError ?? false, false);
  const details = res.details as { servers?: Array<{ name: string; tools: unknown[] }> };
  const octo = details.servers?.find((srv) => srv.name === 'octocode');
  assert.ok(octo && octo.tools.length > 0, 'octocode server returns a non-empty tool list');
});

// ─── config watcher: reconcile + lifecycle ────────────────────────────────────
import {
  computeReload,
  configSignature as sig,
  startMcpConfigWatcher,
  stopMcpConfigWatchers,
} from '../src/tools/mcp-tool.js';

test('computeReload flags drifted and removed servers, ignores unchanged', () => {
  const a = { command: 'node', args: ['a.js'] };
  const running = new Map<string, string>([
    ['stable', sig(a)],
    ['drifted', sig({ command: 'node', args: ['old.js'] })],
    ['gone', sig({ command: 'x' })],
  ]);
  const servers = new Map([
    ['stable', a],
    ['drifted', { command: 'node', args: ['new.js'] }],
    // 'gone' intentionally absent
  ]);
  const { changed, removed } = computeReload(running, servers);
  assert.deepEqual(changed, ['drifted']);
  assert.deepEqual(removed, ['gone']);
});

test('startMcpConfigWatcher starts watchers and stop closes them', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-watch-'));
  const ctx = { cwd } as unknown as import('../src/types.js').PiContext;
  try {
    const started = startMcpConfigWatcher(ctx, () => {});
    assert.ok(started > 0, 'at least the global + project dirs are watched');
    const stopped = stopMcpConfigWatchers();
    assert.equal(stopped, started);
    assert.equal(stopMcpConfigWatchers(), 0, 'idempotent stop');
  } finally {
    stopMcpConfigWatchers();
  }
});
