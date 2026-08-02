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

test('env defaults: full-text MCP responses + npm cache vars are always on for the octocode server', () => {
  assert.equal(OCTOCODE_MCP_ENV_DEFAULTS['OCTOCODE_MCP_FULL_TEXT'], 'true');
  assert.equal(OCTOCODE_MCP_ENV_DEFAULTS['npm_config_include'], 'optional');
  assert.ok(OCTOCODE_MCP_ENV_DEFAULTS['npm_config_cache']!.length > 0);
});

// ─── patchGlobalMcpOctocodeEnv ───────────────────────────────────────────────

test('patch: adds missing env vars (incl. OCTOCODE_MCP_FULL_TEXT) to the octocode server entry', () => {
  const p = tmpMcpJson({ mcpServers: { octocode: { command: 'node', args: ['x.js'] } } });
  patchGlobalMcpOctocodeEnv(p);
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const env = raw.mcpServers.octocode.env;
  assert.equal(env.OCTOCODE_MCP_FULL_TEXT, 'true');
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
