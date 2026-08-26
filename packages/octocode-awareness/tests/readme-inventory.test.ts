import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

it('publishes the complete shared feature and entity inventory', () => {
  const readme = readFileSync(resolve(packageRoot, 'README.md'), 'utf8');
  for (const feature of [
    'Status', 'Plans', 'Tasks', 'Work presence', 'Locks', 'Checks', 'Messages',
    'Agents', 'Handoffs', 'Memory', 'Hooks', 'Schema', 'Pi composition', 'Runtime workflows',
  ]) expect(readme).toContain(`| ${feature} |`);
  for (const table of [
    'plans', 'tasks', 'locks', 'work_presence', 'handoffs', 'memories', 'agents',
    'messages', 'message_receipts', 'octocode_meta', 'agent_sessions',
    'mcp_server_overrides', 'mcp_tool_overrides', 'skill_overrides', 'mcp_catalog_state',
  ]) expect(readme).toContain(`\`${table}\``);
  expect(readme).toContain('@octocodeai/octocode-awareness');
  expect(readme).toContain('octocode-awareness');
  expect(readme).not.toMatch(/octocode-awareness-lite|\/lite\b|Awareness Lite/);
});
