import { execFile } from 'node:child_process';
import { ToolRegistry, type JsonSchema, type ToolEffect } from '@octocodeai/agent-core';

export interface OctocodeCatalogTool {
  name: string;
  description: string;
  category?: string;
  inputSchema?: JsonSchema;
}

export interface OctocodeCatalog {
  tools: readonly OctocodeCatalogTool[];
}

export type OctocodeToolExecutor = (name: string, input: unknown, signal: AbortSignal) => Promise<unknown>;

function effectFor(tool: OctocodeCatalogTool): ToolEffect {
  return tool.category === 'GitHub' || tool.category === 'npm' || tool.name.startsWith('gh') || tool.name === 'npmSearch'
    ? 'network'
    : 'read';
}

export function createOctocodeToolRegistry(catalog: OctocodeCatalog, execute: OctocodeToolExecutor): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of catalog.tools) {
    const effect = effectFor(tool);
    registry.register({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      schemaVersion: 1,
      inputSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true },
      outputSchema: {},
      outputVersion: 1,
      policy: {
        effect,
        trust: effect === 'network' ? 'workspace' : 'none',
        approval: effect === 'network' ? 'on-request' : 'never',
        plan: 'allowed',
      },
      async execute(input) {
        const content = await execute(tool.name, input.input, input.signal);
        return { ok: true, content, detailsVersion: 1 };
      },
    }, 'octocode-catalog');
  }
  return registry;
}

function execOctocode(args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('npx', ['octocode', ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function loadOctocodeCatalog(): Promise<OctocodeCatalog> {
  const parsed = JSON.parse(await execOctocode(['tools', '--json'])) as Partial<OctocodeCatalog>;
  if (!Array.isArray(parsed.tools)) throw new Error('Octocode tool catalog is invalid');
  const tools = parsed.tools.filter((tool): tool is OctocodeCatalogTool => (
    typeof tool === 'object' && tool !== null
    && typeof (tool as OctocodeCatalogTool).name === 'string'
    && typeof (tool as OctocodeCatalogTool).description === 'string'
  ));
  return {
    tools: await Promise.all(tools.map(async (tool) => {
      const schema = JSON.parse(await execOctocode(['tools', tool.name, '--scheme', '--json'])) as { inputSchema?: JsonSchema };
      if (!schema.inputSchema || typeof schema.inputSchema !== 'object') throw new Error(`Octocode schema is invalid: ${tool.name}`);
      return { ...tool, inputSchema: schema.inputSchema };
    })),
  };
}

export async function executeOctocodeTool(name: string, input: unknown, signal: AbortSignal): Promise<unknown> {
  const query = typeof input === 'object' && input !== null && 'queries' in input
    ? (input as { queries: unknown }).queries
    : input;
  const stdout = await execOctocode(['tools', name, '--queries', JSON.stringify(query), '--compact'], signal);
  return JSON.parse(stdout) as unknown;
}

export async function createDefaultOctocodeToolRegistry(): Promise<ToolRegistry> {
  return createOctocodeToolRegistry(await loadOctocodeCatalog(), executeOctocodeTool);
}
