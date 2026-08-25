import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { parseMcpManagerAction, renderMcpManagerPage } from '../src/tools/mcp-html.js';
import type { PiContext } from '../src/types.js';

const originalHome = process.env['OCTOCODE_HOME'];
const roots: string[] = [];
afterEach(() => {
  if (originalHome === undefined) delete process.env['OCTOCODE_HOME'];
  else process.env['OCTOCODE_HOME'] = originalHome;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

test('MCP manager action schema accepts references and rejects raw secret fields', () => {
  const action = parseMcpManagerAction({
    action: 'add',
    server: 'docs',
    scope: 'global',
    config: { url: 'https://mcp.example.test/api', headerRefs: { Authorization: 'DOCS_AUTH' } },
  });
  assert.equal(action.action, 'add');
  assert.throws(() => parseMcpManagerAction({
    action: 'add',
    server: 'docs',
    scope: 'global',
    config: { url: 'https://mcp.example.test/api', headers: { Authorization: 'Bearer secret' } },
  }), /Unsupported MCP config field: headers/);
  assert.throws(() => parseMcpManagerAction({ action: 'retry', server: 'docs', scope: 'invalid' }), /Invalid MCP scope/);
  assert.throws(() => parseMcpManagerAction({ action: 'retry', server: 'docs', unexpected: true }), /Unsupported MCP action field/);
  assert.throws(() => parseMcpManagerAction({
    action: 'add',
    server: 'docs',
    config: { command: 'node', envRefs: { 'BAD-NAME': 'DOCS_AUTH' } },
  }), /Invalid envRefs destination/);
});

test('MCP manager uses the shared page theme and redacts secret values', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-mcp-html-'));
  roots.push(root);
  process.env['OCTOCODE_HOME'] = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');
  const configPath = path.join(cwd, '.octocode', 'agent', 'mcp', 'servers.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { docs: {
    url: 'https://mcp.example.test/api',
    headers: { Authorization: 'Bearer SECRET', 'X-Tenant': 'acme' },
  } } }));
  const html = await renderMcpManagerPage({ cwd, isProjectTrusted: async () => true } as unknown as PiContext, 'test-action-token');
  assert.match(html, /MCP connections/);
  assert.match(html, /--teal:#5EEAD4/);
  assert.match(html, /streamable-http/);
  assert.match(html, /Authorization/);
  assert.doesNotMatch(html, /Bearer SECRET/);
  assert.match(html, /data-action="disable" data-server="docs"/);
  assert.match(html, /Add or edit server/);
  assert.match(html, /Environment references/);
  assert.match(html, /Header references/);
  assert.match(html, /Connect \/ retry/);
  assert.match(html, /Effective scope: project/);
  assert.match(html, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /x-octocode-action-token/);
  assert.match(html, /test-action-token/);
  assert.doesNotMatch(html, /name="env"|name="headers"/);
});
