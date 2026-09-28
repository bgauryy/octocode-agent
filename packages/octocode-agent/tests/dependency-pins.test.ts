import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

describe('protocol dependency pins', () => {
  it('keeps wire-protocol SDKs on reviewed exact versions', () => {
    const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PackageManifest;

    expect(manifest.dependencies).toMatchObject({
      '@agentclientprotocol/sdk': '1.4.0',
      '@ai-sdk/anthropic': '4.0.45',
      '@ai-sdk/openai': '4.0.51',
      '@ai-sdk/openai-compatible': '3.0.40',
      '@modelcontextprotocol/client': '2.0.0',
      ai: '7.0.84',
    });
  });

  it('keeps unpublished workspace implementations build-time only', () => {
    const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PackageManifest;
    const unpublished = ['@octocodeai/agent-core', '@octocodeai/agent-contracts'];

    for (const name of unpublished) {
      expect(manifest.dependencies ?? {}).not.toHaveProperty(name);
      expect(manifest.optionalDependencies ?? {}).not.toHaveProperty(name);
      expect(manifest.peerDependencies ?? {}).not.toHaveProperty(name);
      expect(manifest.devDependencies).toHaveProperty(name, '0.1.0');
    }
  });
});
