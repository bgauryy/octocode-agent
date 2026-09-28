import fs from 'node:fs';
import os from 'node:os';
import { closeOctocodeDb, openOctocodeDb } from '@octocodeai/agent-contracts/db';
import { getMcpEnablement, getSkillEnablement } from '@octocodeai/agent-contracts/mcp-state';
import { discoverMcpSystem, repositoryDirectories } from '@octocodeai/agent-contracts/agent-skills';
import { agentDbPath, getOctocodeHome } from '@octocodeai/agent-contracts/paths';

import { loadNativeMcpServers } from './native-mcp.js';
import { resolveNativeModelConfiguration } from './native-provider-registry.js';
import { listNativeSkillInventory } from './native-skills.js';

export interface NativeDiscoveryOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly configuredProvider?: string;
  readonly configuredModel?: string;
  readonly workspaceTrusted?: boolean;
  readonly now?: () => Date;
}

export function buildNativeDiscoverySnapshot(options: NativeDiscoveryOptions) {
  const homeDir = options.env.HOME ?? os.homedir();
  const octocodeHome = getOctocodeHome(options.env);
  const models = resolveNativeModelConfiguration({
    env: options.env,
    cwd: options.cwd,
    home: homeDir,
    octocodeHome,
    configuredProvider: options.configuredProvider,
    configuredModel: options.configuredModel,
    workspaceTrusted: options.workspaceTrusted,
  });
  const mcpConfigs = new Map(repositoryDirectories(options.cwd).flatMap((directory) =>
    discoverMcpSystem(directory, { homeDir, octocodeHome }).configs.map((config) => [config.path, config] as const),
  ));
  const servers = loadNativeMcpServers({ cwd: options.cwd, env: options.env, homeDir, octocodeHome });
  const dbFile = agentDbPath(options.env);
  const db = fs.existsSync(dbFile) ? openOctocodeDb(dbFile) : undefined;
  try {
    const skills = listNativeSkillInventory({
      cwd: options.cwd,
      homeDir,
      octocodeHome,
      workspaceTrusted: options.workspaceTrusted,
      isEnabled: (name, defaultEnabled, source) => db === undefined ? defaultEnabled : getSkillEnablement(db, options.cwd, name, defaultEnabled, source.id),
    });
    const mcpServers = Object.entries(servers).sort(([left], [right]) => left.localeCompare(right)).map(([name, config]) => ({
      name,
      transport: config.transport,
      enabled: db === undefined ? config.defaultEnabled ?? true : getMcpEnablement(db, options.cwd, name, undefined, config.defaultEnabled ?? true),
      vendor: config.discovered?.host ?? 'octocode',
      scope: config.provenance?.scope ?? 'workspace',
      path: config.provenance?.file,
    }));
    return {
      schemaVersion: 1 as const,
      generatedAt: (options.now ?? (() => new Date()))().toISOString(),
      workspace: options.cwd,
      models: {
        selection: models.selection,
        selectionSource: models.selectionSource,
        credential: models.credential,
        sources: models.catalog.sources,
        providers: models.catalog.providers,
        entries: models.catalog.models,
      },
      mcp: {
        sources: [...mcpConfigs.values()].map((source) => ({
          vendor: source.host,
          scope: source.scope === 'project' ? 'workspace' as const : 'global' as const,
          path: source.path,
          format: source.format,
          enabled: source.active,
          status: source.error ? 'invalid' as const : 'valid' as const,
          ...(source.error ? { diagnostic: source.error } : {}),
          servers: source.servers.map(({ name }) => name),
        })),
        servers: mcpServers,
      },
      skills: {
        sources: skills.entries.map((entry) => ({
          name: entry.name,
          vendor: entry.vendor,
          sourceId: entry.source,
          scope: entry.scope,
          path: entry.path,
          precedence: entry.precedence,
          enabled: entry.enabled,
          status: entry.parseStatus,
          revision: entry.revision,
          ...(entry.diagnostic ? { diagnostic: entry.diagnostic } : {}),
        })),
        errors: skills.errors,
      },
    };
  } finally {
    if (db !== undefined) closeOctocodeDb(dbFile);
  }
}

export type NativeDiscoverySnapshot = ReturnType<typeof buildNativeDiscoverySnapshot>;
